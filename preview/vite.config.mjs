import { defineConfig } from "vite"
import path from "node:path"
export default defineConfig({
  root: path.dirname(new URL(import.meta.url).pathname),
  base:"./",
  resolve:{alias:{"@":path.resolve(path.dirname(new URL(import.meta.url).pathname),"..")}},
  esbuild:{jsx:"automatic"},
  build:{outDir:"../preview-dist",emptyOutDir:true},
})
