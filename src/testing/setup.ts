// Every test file starts with the core's network port registered, as the plugin does at its start (#418). A test
// that wants another port passes it where the client is made (`LlmSettings.http`, `fetchPublic`'s rules).
import { setHttpPort } from "../core/http";
import { nodeHttp } from "../net/nodeHttp";

setHttpPort(nodeHttp);
