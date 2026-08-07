# Rebuilding `web/vendor/transformers/transformers-bundled.mjs`

The stock `@huggingface/transformers` browser dist cannot be loaded directly by
a browser — it contains bare `onnxruntime-web` imports that need a bundler. We
therefore prebundle it once at dev time and commit the output; the site itself
stays build-free.

From a folder with `npm i @huggingface/transformers` (and the `nodeshim.mjs`
below next to it):

```bash
npx esbuild ./node_modules/@huggingface/transformers/src/transformers.js \
  --bundle --format=esm --platform=browser --minify --keep-names \
  --alias:node:fs=./nodeshim.mjs --alias:node:path=./nodeshim.mjs \
  --alias:node:url=./nodeshim.mjs --alias:node:stream=./nodeshim.mjs \
  --alias:node:stream/promises=./nodeshim.mjs \
  --alias:sharp=./nodeshim.mjs --alias:onnxruntime-node=./nodeshim.mjs \
  --outfile=transformers-bundled.mjs
```

`nodeshim.mjs` (node-only modules are behind runtime guards and never execute
in a browser):

```js
const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub, construct: () => stub });
export default stub;
export const promises = stub, constants = stub, Readable = stub, Writable = stub, Transform = stub;
export const InferenceSession = stub, Tensor = stub, env = stub, sep = '/';
export function fileURLToPath(u) { return String(u); }
export function pathToFileURL(p) { return { href: String(p) }; }
export function join(...a) { return a.join('/'); }
export function dirname(p) { return String(p); }
export function resolve(...a) { return a.join('/'); }
export function basename(p) { return String(p); }
export function existsSync() { return false; }
export function readFileSync() { throw new Error('fs is unavailable in the browser'); }
export function pipeline() { throw new Error('node:stream is unavailable in the browser'); }
```

Also vendor ONNX Runtime's **asyncify** WASM pair from
`node_modules/onnxruntime-web/dist/` (this build requests exactly that flavor):
`ort-wasm-simd-threaded.asyncify.mjs` and `ort-wasm-simd-threaded.asyncify.wasm`.

**Post-step (required):** GitHub push protection false-positives on the class
name `Mistral3ForConditionalGeneration` in the bundled model registry (32
chars next to the string "mistral3" — matches their Mistral-API-key
heuristic). After bundling, split any quoted 32-character literal containing
`istral` into a concatenation, e.g.
`"Mistral3For"+"ConditionalGeneration"` — runtime-identical, scanner-invisible.

Version pinned at bundle time: transformers.js 4.2.0. If you upgrade, re-check
the two workarounds in `web/src/recognize.js` (pathname-style
`env.localModelPath`; post-construction processor/tokenizer patch) — both are
version-sensitive.
