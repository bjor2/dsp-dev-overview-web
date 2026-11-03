// DSP Dev Overview front door entry point. App: ./app.js (ADR-006 OIDC + session + /api proxy, ADDENDA-006 upstreams).
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT || 3000);
let app;
try { app = createApp(process.env); } catch (e) { console.error(e.message); process.exit(1); }
app.listen(PORT, () => console.log(`dsp-dev-overview-web on :${PORT} (${app.locals.describe()})`));
