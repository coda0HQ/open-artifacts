declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/index");
  }
}

// Wrangler compiles imported .wasm into a WebAssembly.Module at bundle time.
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
