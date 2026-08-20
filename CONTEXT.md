# ASM Agent

Static amber CRT chat that talks to OpenRouter through a WAT engine. The context covers chat, model catalog, and free-tier access.

## Language

**Free Model**:
A model whose OpenRouter id ends with `:free` and is available at zero cost on the free tier.
_Avoid_: free-tier model, zero-cost model

**Operator Key**:
The single `sk-or-...` key owned by the operator and held only on the server to authorize free-model requests.
_Avoid_: shared key, public key, embedded key

**Anonymous User**:
A visitor who uses the agent without supplying an API key.
_Avoid_: guest, unauthenticated user

**BYO User**:
A visitor who supplies their own OpenRouter key via SET.
_Avoid_: logged-in user, paid user

**Proxy**:
The server edge that receives `POST /api/chat` from the browser and forwards it to OpenRouter with the Operator Key.
_Avoid_: backend, gateway, middleware

**Rate Limit**:
The per-IP quota the Proxy can enforce on Anonymous Users to protect the Operator Key. Currently not enforced — Anonymous Users rely on the Operator Key's OpenRouter limit (429); enforcement is deferred until abuse is observed.
_Avoid_: throttling, quota
