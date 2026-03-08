export async function scanTasksFromImage(adapter = null) {
  if (!adapter || typeof adapter.scan !== 'function') {
    return [];
  }

  return adapter.scan();
}
