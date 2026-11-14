---
name: validar-release
description: Ejecuta la batería de validación técnica antes de una release o despliegue en Nature Planner. Comprueba tests de unidad, compilación de producción, accesibilidad Playwright, tamaños gzip de bundles y respuesta HTTP 200 en producción. Úsala antes de fusionar a main o etiquetar versiones semver.
---

# Skill: Validar Release (`validar-release`)

Esta skill define el procedimiento riguroso de verificación técnica antes de certificar una nueva versión o despliegue a producción de Nature Planner.

> [!IMPORTANT]
> **REGLA DE VERACIDAD**: Queda terminantemente prohibido asumir o inventar resultados. Cada punto de la lista debe validarse ejecutando el comando correspondiente y reportando su salida real. Si algún paso falla, la release queda bloqueada.

---

## Procedimiento de Validación Paso a Paso

### 1. Tests Unitarios y Lógica de Dominio
Ejecuta la suite completa de pruebas en Bun:
```bash
bun test
```
- **Criterio de éxito**: 100% de los tests en `src/` deben pasar en verde sin advertencias no controladas.
- **Áreas críticas evaluadas**: Cascada horaria (`cascade.test.ts`), importación/exportación (`importValidation.test.ts`), cálculo LWW (`sync.test.ts`), cifrado (`crypto.test.ts`).

### 2. Compilación de Producción (Build)
Ejecuta el build con el adaptador de Astro para Vercel:
```bash
bun run build
```
- **Criterio de éxito**: Código de salida `0`. Sin errores de tipos TypeScript ni advertencias de importaciones circulares o assets no encontrados.

### 3. Suite de Accesibilidad y UI (Playwright)
Si el cambio modificó componentes Svelte, páginas Astro, estilos CSS o tokens:
```bash
bun run test:a11y
```
- **Criterio de éxito**: Pruebas `tests/accessibility.spec.ts` en verde en tema claro y tema oscuro (contraste ≥ 4.5:1, touch targets ≥ 44px, cero violaciones `axe-core`).

### 4. Inspección de Tamaños de Bundle (Gzip)
Revisa los archivos generados en `.vercel/output/static/_astro/`:
```powershell
Get-ChildItem -Path .vercel/output/static/_astro/*.js | ForEach-Object {
  $stream = [System.IO.File]::OpenRead($_.FullName)
  $ms = New-Object System.IO.MemoryStream
  $gz = New-Object System.IO.Compression.GZipStream($ms, [System.IO.Compression.CompressionMode]::Compress)
  $stream.CopyTo($gz)
  $gz.Close()
  $stream.Close()
  [PSCustomObject]@{
    Archivo = $_.Name
    RawKB = [math]::Round($_.Length / 1KB, 2)
    GzipKB = [math]::Round($ms.ToArray().Length / 1KB, 2)
  }
} | Format-Table -AutoSize
```
- **Criterio de éxito**:
  - El chunk principal de `Dashboard` debe ser `≤ 30 KB` gzip.
  - Ausencia de duplicaciones innecesarias de dependencias en el bundle.

### 5. Health Check en Producción
Comprueba que la URL oficial en Vercel responde satisfactoriamente:
```powershell
curl.exe -I https://horario-taupe.vercel.app/
```
- **Criterio de éxito**:
  - Código HTTP `200 OK`.
  - Presencia de cabeceras de caché esperadas (`x-vercel-cache: HIT` o `MISS`).
  - Verificación visual o por payload del splash screen inicial sin parpadeos ni errores en consola.

---

## Formato del Reporte de Validación

Al finalizar, emite un reporte estructurado con las salidas reales obtenidas:
```markdown
### Reporte de Validación de Release

- **`bun test`**: [N tests pasados / 0 fallados en X ms]
- **`bun run build`**: [Exitoso / Duración X s]
- **`bun run test:a11y`**: [N passed / 0 failed] (o N/A si no hubo cambios de UI)
- **Tamaños de Bundle**: [Dashboard chunk: X KB gzip (esperado ≤ 30 KB)]
- **Producción (`https://horario-taupe.vercel.app/`)**: [HTTP 200 OK / Splash presente]
- **Estado**: [LISTO PARA RELEASE / BLOQUEADO]
```
