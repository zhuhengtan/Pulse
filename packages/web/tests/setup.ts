// Node's Request and jsdom's AbortSignal belong to different realms. Keep the
// signal exposed to the router without passing jsdom's signal into undici.
const NativeRequest = globalThis.Request
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const { signal, ...options } = init ?? {}
    super(input, options)
    if (signal) Object.defineProperty(this, 'signal', { value: signal })
  }
}
