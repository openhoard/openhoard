import { defineConfig } from "vitest/config";
import { preset } from "@openhoard/config/vitest";

export default defineConfig(preset({ floor: 85 }));
