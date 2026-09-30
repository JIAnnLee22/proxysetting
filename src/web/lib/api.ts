import { adminAuthHeader, clearAdminAuth } from './auth'

export async function api<T = any>(
  path: string,
  method = 'GET',
  data?: any,
  overrideAuthHeader?: string | null
): Promise<T> {
  const url = '/api/admin/' + path.replace(/^\//, '')
  const headers: Record<string, string> = {}

  if (data) {
    headers['Content-Type'] = 'application/json'
  }

  // Attach auth header if provided or available in state
  const auth = overrideAuthHeader !== undefined ? overrideAuthHeader : adminAuthHeader.value
  if (auth) {
    headers['Authorization'] = auth
  }

  const response = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    cache: 'no-store'
  })

  if (!response.ok) {
    let errorMsg = '请求失败'
    try {
      const errJson = await response.json()
      if (errJson && errJson.error) {
        errorMsg = errJson.error
      }
    } catch {
      errorMsg = `HTTP 错误 ${response.status}`
    }

    if (response.status === 401 && !overrideAuthHeader && adminAuthHeader.value) {
      // Current token expired or invalid
      clearAdminAuth()
    }

    throw new Error(errorMsg)
  }

  // Check if response is json or text
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    return (await response.json()) as T
  }
  return (await response.text()) as unknown as T
}
