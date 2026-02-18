# Master key (Phase 1)

File: `master.key`

- This is the AES-256-GCM master key used to encrypt SSH private keys stored in the control-plane SQLite DB.
- **Do not** commit this file.
- Permissions should be `600`.
- **Back it up offline.** If you lose it, you cannot decrypt stored SSH keys, which may permanently lose access to delivery machines.

Backup procedure (Phase 1/A):
1. Copy `control-plane/keys/master.key` to a secure offline location (password manager secure file, encrypted USB, etc.).
2. Also back up the SQLite DB file: `control-plane/data/bothook.sqlite`.
3. Keep at least 2 copies in separate places.

Rotation note:
- If the master key is rotated, you must re-encrypt all stored SSH private keys.
