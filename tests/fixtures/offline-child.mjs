const fetchOnline = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('OFFLINE_TEST_CHILD_NETWORK_BLOCKED')
  return fetchOnline(input, init)
}
