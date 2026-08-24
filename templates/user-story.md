---
project: "Q1 2026 Release"
---

## As a user, I want to log in so that I can access my account

```yaml
plane_id:
plane_identifier:
plane_url:
priority: high
labels: [Feature, Auth]
assignee: jane@company.com
status: Backlog
```

**Outcome:** after this lands, a returning user with valid credentials reaches the dashboard.
Today there is no way to authenticate at all.

**Effort:** 3 dev-days

Login is email + password against the existing identity store. Rate limiting is per-account, not
per-IP, because the threat we are pricing is credential stuffing against known addresses.

### Acceptance Criteria

- [ ] Invalid credentials return the SAME error and timing as an unknown email, so the response does
      not reveal whether an account exists
- [ ] The sixth consecutive failed attempt within 15 minutes is refused even with correct credentials
- [ ] A successful login after a partial failure streak resets the counter to zero
- [ ] Session cookies are `HttpOnly` and `Secure`; a token issued over plain HTTP is rejected

## As a user, I want to reset my password so that I can regain access

```yaml
plane_id:
plane_identifier:
plane_url:
priority: medium
labels: [Feature, Auth]
```

**Outcome:** after this lands, a user locked out of their account can regain access without a
support ticket. Today the only route is a manual reset by an operator.

**Effort:** 2 dev-days

Reset is by emailed single-use link. Deliberately no security questions — see the epic rationale.

### Acceptance Criteria

- [ ] A reset link is single-use: the second redemption is refused even inside the validity window
- [ ] A link older than 24 hours is refused, and the refusal does not say whether the token existed
- [ ] Requesting a reset for an unknown address returns the same response as a known one
- [ ] The old password stops working the moment a reset completes, on every active session
