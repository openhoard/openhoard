// Puts what the browser loads beside the compiled scripts: dist/ is the extension, unpacked.
import { cpSync } from "node:fs";

const here = new URL("..", import.meta.url);
cpSync(new URL("static/", here), new URL("dist/", here), { recursive: true });
