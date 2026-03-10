# Support Runbook: Open Ports via Cloud Security Group (A-mode)

Policy (owner): **Support A** = help users by adjusting **cloud-side security group only**. Do **not** modify in-VM firewall (UFW/iptables) unless explicitly approved in a separate request.

## Intake (required from user)
User must provide these in the support ticket email thread:
- **UUID / delivery link** (required)
- **WhatsApp phone number** (required; used to verify binding)
- Requested change:
  - Protocol: TCP/UDP
  - Port(s): single port or small range
  - **Source allowlist**: CIDR (prefer allowlist; avoid 0.0.0.0/0)
  - Purpose/service
  - Duration: temporary/long-term (end time if temporary)

## Verification
Before making any change, verify requester controls the instance:
1) Look up `WA_LINKED/UUID_BOUND` for the provided WA phone and ensure it maps to the provided UUID/delivery.
2) Confirm the delivery is **PAID/DELIVERED** (or otherwise authorized by owner policy).
3) Resolve the **instance_id + public_ip** from DB.

## Change (cloud-side security group)
- Provider: Tencent Lighthouse (current).
- Principle: least privilege.
  - Prefer allowlisted sources.
  - Prefer small port ranges.
  - Avoid exposing SSH/RDP/DB ports to the Internet.

## Response template (email)
- Confirm what was changed:
  - Protocol + port(s)
  - Source CIDR(s)
  - Effective scope (cloud-side SG only)
  - When it will be reverted if temporary
- Ask user to confirm service is reachable.

## Notes
- This runbook intentionally avoids in-VM firewall changes. If the user’s service still isn’t reachable, request confirmation whether they have local firewall enabled and propose upgrading support level (B) with explicit approval.
