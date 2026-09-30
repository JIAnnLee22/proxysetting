export async function api<T = any>(path: string, method = 'GET', data?: any): Promise<T> {
  const url = '/api/admin/' + path.replace(/^\//, '')
  const response = await fetch(url, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
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
    throw new Error(errorMsg)
  }

  // Check if response is json or text
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    return (await response.json()) as T
  }
  return (await response.text()) as unknown as T
}
