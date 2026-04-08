package place

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image/color"
	"image/draw"
	"image/png"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  64,
	WriteBufferSize: 64,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
	Error: func(w http.ResponseWriter, req *http.Request, status int, err error) {
		log.Println(err)
		http.Error(w, "Error while trying to make websocket connection.", status)
	},
}

type Server struct {
	sync.RWMutex
	msgs      chan []byte
	chatMsgs  chan []byte
	close     chan int
	clients   []chan []byte
	chatClose chan int
	chatClients []chan []byte
	img       draw.Image
	imgBuf    []byte
	recordBuf []byte
	enableWL  bool
	whitelist map[string]uint16
	record    draw.Image

	// chat persistence (simple bounded history)
	chatMu      sync.Mutex
	chatHistory [][]byte
	chatPath    string
	chatCountry string
	chatEnableFlag bool
	geoipMu sync.Mutex
	geoipCountryCache map[string]string // ip string -> country code
	geoipHTTP *http.Client

	// --- Phase 3: coordination (in-memory + TTL only; not durable) ---
	coordMu sync.Mutex
	claims map[string]*RegionClaim
	presence map[string]*AgentPresence
}

type Rect struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

type RegionClaim struct {
	ClaimID string `json:"claim_id"`
	AgentID string `json:"agent_id"`
	Region  Rect   `json:"region"`
	Reason  string `json:"reason,omitempty"`
	ExpiresTS int64 `json:"expires_ts"`
}

type AgentPresence struct {
	AgentID string `json:"agent_id"`
	DisplayName string `json:"display_name,omitempty"`
	Version string `json:"version,omitempty"`
	LastSeenTS int64 `json:"last_seen_ts"`
}

func NewServer(img draw.Image, count int, enableWL bool, whitelist map[string]uint16, record draw.Image) *Server {
		sv := &Server{
		RWMutex:   sync.RWMutex{},
		msgs:      make(chan []byte),
		chatMsgs:  make(chan []byte),
		close:     make(chan int),
		clients:   make([]chan []byte, count),
		chatClose: make(chan int),
		chatClients: make([]chan []byte, count),
		img:       img,
		enableWL:  enableWL,
		whitelist: whitelist,
		record:    record,
		chatHistory: make([][]byte, 0, 200),
		chatPath:    "/var/lib/rbxb-place/chat.jsonl",
		chatCountry: "", // unused (kept for compatibility)
		chatEnableFlag: true,
		geoipCountryCache: map[string]string{},
		geoipHTTP: &http.Client{Timeout: 2 * time.Second},
		claims: map[string]*RegionClaim{},
		presence: map[string]*AgentPresence{},
	}
	// GeoIP: external lookup (api.country.is) with in-memory caching; no raw IP persisted/broadcast.
	go sv.broadcastLoop()
	go sv.chatBroadcastLoop()
	return sv
}

func (sv *Server) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	switch path.Base(req.URL.Path) {
	case "place.png":
		sv.HandleGetImage(w, req)
	case "stat":
		sv.HandleGetStat(w, req)
	case "ws":
		sv.HandleSocket(w, req)
	case "chatws":
		sv.HandleChatSocket(w, req)
	case "claims":
		sv.HandleClaims(w, req)
	case "presence":
		sv.HandlePresence(w, req)
	case "verifykey":
		sv.HandleSetKeyCookie(w, req)
	default:
		http.Error(w, "Not found.", 404)
	}
}

// --- Chat (minimal persistent realtime layer) ---

func (sv *Server) loadChatHistoryLocked() {
	// idempotent: if already loaded, skip
	if len(sv.chatHistory) > 0 {
		return
	}
	b, err := os.ReadFile(sv.chatPath)
	if err != nil {
		return
	}
	lines := bytes.Split(b, []byte{'\n'})
	// keep latest tail (up to 200 non-empty lines)
	nonEmpty := make([][]byte, 0, len(lines))
	for _, ln := range lines {
		if len(ln) == 0 {
			continue
		}
		nonEmpty = append(nonEmpty, ln)
	}
	start := 0
	if len(nonEmpty) > 200 {
		start = len(nonEmpty) - 200
	}
	for _, ln := range nonEmpty[start:] {
		// keep as raw json line
		sv.chatHistory = append(sv.chatHistory, append([]byte(nil), ln...))
	}
}

func (sv *Server) appendChatPersist(line []byte) {
	// Best-effort append; keep simple
	_ = os.MkdirAll(filepath.Dir(sv.chatPath), 0755)
	f, err := os.OpenFile(sv.chatPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		log.Println("chat persist open:", err)
		return
	}
	defer f.Close()
	_, err = f.Write(append(line, '\n'))
	if err != nil {
		log.Println("chat persist write:", err)
	}
}

func (sv *Server) HandleChatSocket(w http.ResponseWriter, req *http.Request) {
	// reuse same upgrader; path is /chatws
	// Determine coarse country code per-connection (no raw IP persisted/broadcast).
	cc := ""
	maskedIP := ""
	ipHash := ""
	if sv.chatEnableFlag {
		if ip := trustedClientIPFromRequest(req); ip != nil {
			cc = sv.detectCountryCodeFromIP(ip)
		}
	}

	// Reserve a slot briefly under lock, but do NOT hold lock during websocket upgrade.
	sv.Lock()
	i := sv.getChatConnIndex()
	if i == -1 {
		sv.Unlock()
		http.Error(w, "Server full.", 503)
		return
	}
	// Reserve the slot with a placeholder to prevent races.
	sv.chatClients[i] = make(chan []byte, 1)
	sv.Unlock()

	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Println(err)
		// release reserved slot
		sv.Lock()
		if sv.chatClients[i] != nil {
			close(sv.chatClients[i])
			sv.chatClients[i] = nil
		}
		sv.Unlock()
		return
	}

	ch := make(chan []byte, 32)
	// Store real channel under lock.
	sv.Lock()
	// close placeholder if still present
	if sv.chatClients[i] != nil {
		close(sv.chatClients[i])
	}
	sv.chatClients[i] = ch
	sv.Unlock()

	go sv.chatReadLoop(conn, i, cc, maskedIP, ipHash)
	go sv.chatWriteLoop(conn, ch)
}

// --- Chat: trusted client IP + coarse country (no raw IP persisted/broadcast) ---

func trustedClientIPFromRequest(req *http.Request) net.IP {
	// Trust X-Forwarded-For only when the immediate peer is loopback (i.e., local reverse proxy).
	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		host = req.RemoteAddr
	}
	peer := net.ParseIP(host)
	if peer == nil || !peer.IsLoopback() {
		return nil
	}
	xff := req.Header.Get("X-Forwarded-For")
	if xff == "" {
		return nil
	}
	parts := strings.Split(xff, ",")
	first := strings.TrimSpace(parts[0])
	if h, _, err := net.SplitHostPort(first); err == nil {
		first = h
	}
	return net.ParseIP(first)
}

func detectCountryCodeFromIP(ip net.IP) string {
	// Deprecated: use sv.detectCountryCodeFromIP so it can use the cached GeoIP DB.
	_ = ip
	return ""
}

func (sv *Server) detectCountryCodeFromIP(ip net.IP) string {
	if ip == nil {
		return ""
	}
	ipStr := ip.String()
	// cache
	sv.geoipMu.Lock()
	if cc, ok := sv.geoipCountryCache[ipStr]; ok {
		sv.geoipMu.Unlock()
		return cc
	}
	hc := sv.geoipHTTP
	sv.geoipMu.Unlock()

	// External lookup: api.country.is/{ip} => {"country":"US"}
	req, err := http.NewRequest("GET", "https://api.country.is/"+ipStr, nil)
	if err != nil {
		return ""
	}
	resp, err := hc.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return ""
	}
	var out struct {
		Country string `json:"country"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return ""
	}
	cc := strings.TrimSpace(out.Country)
	if len(cc) != 2 {
		return ""
	}
	// memoize
	sv.geoipMu.Lock()
	sv.geoipCountryCache[ipStr] = cc
	sv.geoipMu.Unlock()
	return cc
}

func countryFlag(cc string) string {
	if len(cc) != 2 {
		return ""
	}
	a := cc[0]
	b := cc[1]
	if a >= 'a' && a <= 'z' {
		a = a - 32
	}
	if b >= 'a' && b <= 'z' {
		b = b - 32
	}
	if a < 'A' || a > 'Z' || b < 'A' || b > 'Z' {
		return ""
	}
	return string([]rune{
		rune(0x1F1E6 + int(a-'A')),
		rune(0x1F1E6 + int(b-'A')),
	})
}

// --- Phase 3: coordination endpoints (in-memory + TTL only) ---

func rectOverlaps(a Rect, b Rect) bool {
	if a.W <= 0 || a.H <= 0 || b.W <= 0 || b.H <= 0 {
		return false
	}
	ax2 := a.X + a.W
	ay2 := a.Y + a.H
	bx2 := b.X + b.W
	by2 := b.Y + b.H
	return a.X < bx2 && ax2 > b.X && a.Y < by2 && ay2 > b.Y
}

func (sv *Server) pruneCoordLocked(now int64) {
	for k, c := range sv.claims {
		if c == nil || c.ExpiresTS <= now {
			delete(sv.claims, k)
		}
	}
	// Presence TTL policy (v0.1): 2 minutes since last_seen.
	for k, p := range sv.presence {
		if p == nil || p.LastSeenTS+120000 <= now {
			delete(sv.presence, k)
		}
	}
}

func (sv *Server) HandleClaims(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if req.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}

	now := time.Now().UnixMilli()
	sv.coordMu.Lock()
	defer sv.coordMu.Unlock()
	sv.pruneCoordLocked(now)

	switch req.Method {
	case "GET":
		// list_active_claims
		claims := make([]*RegionClaim, 0, len(sv.claims))
		for _, c := range sv.claims {
			claims = append(claims, c)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "claims": claims})
		return
	case "POST":
		// claim_region
		var in struct {
			AgentID string `json:"agent_id"`
			Region  Rect   `json:"region"`
			TTLMS   int64  `json:"ttl_ms"`
			Reason  string `json:"reason"`
		}
		if err := json.NewDecoder(req.Body).Decode(&in); err != nil {
			http.Error(w, "bad json", 400)
			return
		}
		if in.AgentID == "" || in.Region.W <= 0 || in.Region.H <= 0 {
			http.Error(w, "invalid", 400)
			return
		}
		ttl := in.TTLMS
		if ttl <= 0 || ttl > 5*60*1000 {
			ttl = 60000
		}
		// conflicts
		conf := []*RegionClaim{}
		for _, c := range sv.claims {
			if c != nil && rectOverlaps(c.Region, in.Region) {
				conf = append(conf, c)
			}
		}
		if len(conf) > 0 {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": map[string]interface{}{"code": "CONFLICT", "message": "overlaps existing claim"}, "conflicts": conf})
			return
		}
		// create claim
		cid := fmt.Sprintf("clm_%d_%d", now, len(sv.claims)+1)
		c := &RegionClaim{ClaimID: cid, AgentID: in.AgentID, Region: in.Region, Reason: in.Reason, ExpiresTS: now + ttl}
		sv.claims[cid] = c
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "claim": c})
		return
	case "DELETE":
		// release_region via query: ?claim_id=...&agent_id=...
		cid := req.URL.Query().Get("claim_id")
		aid := req.URL.Query().Get("agent_id")
		if cid == "" || aid == "" {
			http.Error(w, "missing claim_id/agent_id", 400)
			return
		}
		c := sv.claims[cid]
		if c == nil {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": map[string]interface{}{"code": "NOT_FOUND", "message": "claim not found"}})
			return
		}
		if c.AgentID != aid {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": map[string]interface{}{"code": "FORBIDDEN", "message": "not claim owner"}})
			return
		}
		delete(sv.claims, cid)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
		return
	default:
		http.Error(w, "method", 405)
		return
	}
}

func (sv *Server) HandlePresence(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if req.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}

	now := time.Now().UnixMilli()
	sv.coordMu.Lock()
	defer sv.coordMu.Unlock()
	sv.pruneCoordLocked(now)

	switch req.Method {
	case "GET":
		ps := make([]*AgentPresence, 0, len(sv.presence))
		for _, p := range sv.presence {
			ps = append(ps, p)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "presence": ps})
		return
	case "POST":
		var in AgentPresence
		if err := json.NewDecoder(req.Body).Decode(&in); err != nil {
			http.Error(w, "bad json", 400)
			return
		}
		if in.AgentID == "" {
			http.Error(w, "invalid", 400)
			return
		}
		in.LastSeenTS = now
		sv.presence[in.AgentID] = &in
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "presence": in})
		return
	default:
		http.Error(w, "method", 405)
		return
	}
}

func (sv *Server) getChatConnIndex() int {
	for i, client := range sv.chatClients {
		if client == nil {
			return i
		}
	}
	return -1
}

func (sv *Server) chatWriteLoop(conn *websocket.Conn, ch chan []byte) {
	// on connect: send history snapshot
	sv.chatMu.Lock()
	sv.loadChatHistoryLocked()
	h := make([][]byte, len(sv.chatHistory))
	copy(h, sv.chatHistory)
	sv.chatMu.Unlock()
	for _, ln := range h {
		_ = conn.WriteMessage(websocket.TextMessage, append([]byte("H "), ln...))
	}

	for {
		if p, ok := <-ch; ok {
			_ = conn.WriteMessage(websocket.TextMessage, p)
		} else {
			break
		}
	}
	conn.Close()
}

func (sv *Server) chatReadLoop(conn *websocket.Conn, i int, cc string, maskedIP string, ipHash string) {
	for {
		mt, p, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if mt != websocket.TextMessage {
			continue
		}
		// accept JSON line from client, persist + broadcast
		line := bytes.TrimSpace(p)
		if len(line) == 0 || len(line) > 1000 {
			continue
		}
		// try parse minimal json; if fail, ignore
		var m map[string]interface{}
		if err := json.Unmarshal(line, &m); err != nil {
			continue
		}
		// classify message type (intent vs chat)
		// Trigger rule V1: starts with "@agents "
		text, _ := m["text"].(string)
		msgType := "chat"
		if len(text) >= 8 && text[:8] == "@agents " {
			msgType = "intent"
		}
		m["type"] = msgType
		name, _ := m["name"].(string)
		if name == "" {
			name = "anon"
		}
		// Normalize name to a single stable format:
		// - accept either raw short ID (e.g. "Q9NC")
		// - or legacy prefixed (e.g. "👤-Q9NC", "🇸🇬-Q9NC")
		// - always store/render as "<flag>-<ID>" (fallback 🌍)
		id := name
		if len(id) >= 5 {
			// if contains a dash, take suffix
			for j := len(id) - 1; j >= 0; j-- {
				if id[j] == '-' {
					id = id[j+1:]
					break
				}
			}
		}
		flag := "🌍"
		if f := countryFlag(cc); f != "" {
			flag = f
		}
		m["name"] = flag + "-" + id
		line, _ = json.Marshal(m)
		// store bounded history
		sv.chatMu.Lock()
		if len(sv.chatHistory) == 0 {
			sv.loadChatHistoryLocked()
		}
		sv.chatHistory = append(sv.chatHistory, append([]byte(nil), line...))
		if len(sv.chatHistory) > 200 {
			sv.chatHistory = sv.chatHistory[len(sv.chatHistory)-200:]
		}
		sv.chatMu.Unlock()

		sv.appendChatPersist(line)
		sv.chatMsgs <- append([]byte("M "), line...)
	}
	sv.chatClose <- i
}

func (sv *Server) chatBroadcastLoop() {
	for {
		select {
		case i := <-sv.chatClose:
			if sv.chatClients[i] != nil {
				close(sv.chatClients[i])
				sv.chatClients[i] = nil
			}
		case p := <-sv.chatMsgs:
			for _, ch := range sv.chatClients {
				if ch != nil {
					select {
					case ch <- p:
					default:
						// Fix C: slow client. Drop this one message but keep the client attached.
					}
				}
			}
		}
	}
}

func (sv *Server) HandleGetImage(w http.ResponseWriter, req *http.Request) {
	b := sv.GetImageBytes() //not thread safe but it won't do anything bad
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Write(b)
}

func (sv *Server) HandleGetStat(w http.ResponseWriter, req *http.Request) {
	count := 0
	for _, ch := range sv.clients {
		if ch != nil {
			count++
		}
	}
	fmt.Fprint(w, count)
}

func (sv *Server) HandleSocket(w http.ResponseWriter, req *http.Request) {
	allowDraw := true
	var id uint16 = 0
	if sv.enableWL {
		cookie, err := req.Cookie("key")
		if err == nil {
			id, allowDraw = sv.whitelist[cookie.Value]
		} else {
			allowDraw = false
		}
	}
	sv.Lock()
	defer sv.Unlock()
	i := sv.getConnIndex()
	if i == -1 {
		log.Println("Server full.")
		http.Error(w, "Server full.", 503)
		return
	}
	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Println(err)
		return
	}
	ch := make(chan []byte, 8)
	sv.clients[i] = ch
	go sv.readLoop(conn, i, allowDraw, id)
	go sv.writeLoop(conn, ch, allowDraw)
}

func (sv *Server) HandleSetKeyCookie(w http.ResponseWriter, req *http.Request) {
	if !sv.enableWL {
		http.Error(w, "Whitelist is not enabled.", 400)
		return
	}
	key := req.URL.Query().Get("key")
	if _, ok := sv.whitelist[key]; ok {
		expiration := time.Now().Add(30 * 24 * time.Hour)
		http.SetCookie(w, &http.Cookie{
			Name:     "key",
			Value:    key,
			SameSite: http.SameSiteStrictMode,
			Expires:  expiration,
		})
		w.WriteHeader(200)
	} else {
		http.Error(w, "Bad key.", 401)
	}
}

func (sv *Server) getConnIndex() int {
	for i, client := range sv.clients {
		if client == nil {
			return i
		}
	}
	return -1
}

func rateLimiter() func() bool {
	const rate = 8   // per second average
	const min = 0.01 // kick threshold

	// Minimum time difference between messages
	// Network sometimes delivers two messages in quick succession
	const minDif = int64(time.Millisecond * 50)

	last := time.Now().UnixNano()
	var v float32 = 1.0
	return func() bool {
		now := time.Now().UnixNano()
		dif := now - last
		if dif < minDif {
			dif = minDif
		}
		v *= float32(rate*dif) / float32(time.Second)
		if v > 1.0 {
			v = 1.0
		}
		last = now
		return v > min
	}
}

func (sv *Server) readLoop(conn *websocket.Conn, i int, allowDraw bool, id uint16) {
	limiter := rateLimiter()
	for {
		_, p, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if !allowDraw {
			log.Println("Client kicked for trying to draw without permission.")
			break
		}
		if !limiter() {
			log.Println("Client kicked for high rate.")
			break
		}
		if sv.handleMessage(p, id) != nil {
			log.Println("Client kicked for bad message.")
			break
		}
	}
	sv.close <- i
}

func (sv *Server) writeLoop(conn *websocket.Conn, ch chan []byte, allowDraw bool) {
	allowData := []byte{0}
	if allowDraw {
		allowData[0] = 1
	}
	conn.WriteMessage(websocket.BinaryMessage, allowData)
	for {
		if p, ok := <-ch; ok {
			conn.WriteMessage(websocket.BinaryMessage, p)
		} else {
			break
		}
	}
	conn.Close()
}

func (sv *Server) handleMessage(p []byte, id uint16) error {
	x, y, c := parseEvent(p)
	if !sv.setPixel(x, y, c, id) {
		return errors.New("invalid placement")
	}
	sv.msgs <- p
	return nil
}

func (sv *Server) broadcastLoop() {
	for {
		select {
		case i := <-sv.close:
			if sv.clients[i] != nil {
				close(sv.clients[i])
				sv.clients[i] = nil
			}
		case p := <-sv.msgs:
			for i, ch := range sv.clients {
				if ch != nil {
					select {
					case ch <- p:
					default:
						close(ch)
						sv.clients[i] = nil
					}
				}
			}
		}
	}
}

func (sv *Server) GetImageBytes() []byte {
	if sv.imgBuf == nil {
		buf := bytes.NewBuffer(nil)
		if err := png.Encode(buf, sv.img); err != nil {
			log.Println(err)
		}
		sv.imgBuf = buf.Bytes()
	}
	return sv.imgBuf
}

func (sv *Server) GetRecordBytes() []byte {
	if !sv.enableWL {
		panic("Tried to get record bytes when whitelist is disabled.")
	}
	if sv.recordBuf == nil {
		buf := bytes.NewBuffer(nil)
		if err := png.Encode(buf, sv.record); err != nil {
			log.Println(err)
		}
		sv.recordBuf = buf.Bytes()
	}
	return sv.recordBuf
}

func (sv *Server) setPixel(x, y int, c color.Color, id uint16) bool {
	rect := sv.img.Bounds()
	width := rect.Max.X - rect.Min.X
	height := rect.Max.Y - rect.Min.Y
	if 0 > x || x >= width || 0 > y || y >= height {
		return false
	}
	sv.img.Set(x, y, c)
	sv.imgBuf = nil
	if sv.enableWL {
		sv.record.Set(x, y, color.Gray16{id})
		sv.recordBuf = nil
	}
	return true
}

func parseEvent(b []byte) (int, int, color.Color) {
	if len(b) != 11 {
		return -1, -1, nil
	}
	x := int(binary.BigEndian.Uint32(b))
	y := int(binary.BigEndian.Uint32(b[4:]))
	return x, y, color.NRGBA{b[8], b[9], b[10], 0xFF}
}
