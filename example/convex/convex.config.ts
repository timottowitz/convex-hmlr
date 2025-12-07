import { defineApp } from "convex/server";
import hmlr from "../../src/component/convex.config.js";

const app = defineApp();
app.use(hmlr);

export default app;
