/**
 * Helper compartido para hooks de Antigravity en Nature Planner.
 */

export async function leerStdin(timeoutMs = 500): Promise<string> {
  try {
    if (process.stdin.isTTY) {
      return '';
    }
    const lectura = Bun.stdin.text();
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve(''), timeoutMs));
    return await Promise.race([lectura, timeout]);
  } catch {
    return '';
  }
}
