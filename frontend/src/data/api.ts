const base = (import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '')
if (base && !/^https:\/\/[^/]+/.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) {
  throw new Error('API base URL must use HTTPS')
}
export const apiUrl = (path: string): string => `${base}${path}`
