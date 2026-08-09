# Authorization Matrix

The executable inventory is [src/authorization-matrix.ts](../../src/authorization-matrix.ts). Unknown route/verb combinations are denied; route code must not infer authority merely from visibility.

| Surface | Read | Create / update | Delete / administration | Denied behavior |
| --- | --- | --- | --- | --- |
| Artifact metadata/raw/frame/OG | authorizeView; public default only in the neutral engine | Create policy; artifact write/channel credential or authorizeWrite | artifact credential; visibility requires canManage | private read/manage collapses to 404 |
| Comments | authorizeView | anonymous only when explicitly enabled; otherwise artifact write authority | comment delete capability or artifact write authority | anonymous-off is 403 with stable code |
| Live | authorizeView for connect/status; write authority for draft/checkpoint/edit mutation | artifact write/channel credential or authorizeWrite | artifact write authority | missing/denied artifact is concealed where it is a read oracle |
| Handoff | authorizeView | artifact write authority | handoff delete capability or artifact write authority | private reads are 404 |
| Credential lifecycle | artifact write authority | artifact write authority | revoke by write authority; recovery by canManage | raw token returned only at creation/rotation/recovery |
| Reconciliation | none publicly | dedicated repair secret | execution also requires matching audit confirmation | absent/wrong secret is 404 |

Bearer capabilities and cookie/session authorization remain separate branches. Bearer values are hashed before comparison or limiter key construction and never logged. A SaaS adapter may grant organization/session authority through Authorizer; it must preserve concealment behavior and must not weaken artifact capability validation.
