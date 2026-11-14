---
name: git-sync-ops
description: Runbook operativo de Git y despliegue continuo para el subagente flash_lite en Nature Planner. Detalla la inspección de git status para excluir secretos (.env.local), verificación previa (bun test y bun run build), commits atómicos en español, doble push (main y feat/cloud-sync) y comprobación remota. Actívala antes de cerrar fases de trabajo.
---

# Skill: Operaciones Git y Sincronización Remota (`git-sync-ops`)

Esta skill es el runbook operativo estandarizado para que el subagente `flash_lite` (o el agente responsable de versionado) ejecute de forma segura, atómica y consistente el ciclo de control de versiones y sincronización remota hacia GitHub y Vercel.

> [!IMPORTANT]
> **COMPROMISO DE CONFIRMACIÓN AUTOMÁTICA**: Siguiendo el acuerdo del repositorio (`AGENTS.md`), los commits y pushes rutinarios se realizan **sin pedir confirmación al usuario**, salvo que toquen áreas de **Zona Roja** (pérdida de datos, esquemas/migraciones Drizzle, auth/credenciales o lógica de integridad LWW).

---

## Flujo de Trabajo Operativo

### Paso 1: Inspección de Estado y Protección de Secretos
Inspecciona los archivos modificados y sin seguimiento:
```bash
git status --short
```
- **Filtro de seguridad**:
  - Verificar que `.env.local` esté ignorado y NUNCA aparezca en el staging.
  - Evitar commitear archivos de scratch, temporales o volcados de base de datos.

### Paso 2: Validación Técnica Obligatoria
Antes de preparar el commit, la suite debe estar rigurosamente en verde:
```bash
bun test
bun run build
```
- Si alguno falla, **detener el proceso de inmediato** y devolver el reporte de error sin commitear.

### Paso 3: Preparación de Archivos (Staging)
Añade únicamente los archivos correspondientes a la fase de trabajo:
```bash
git add <rutas-específicas>
```

### Paso 4: Commit Atómico en Español
Crea un commit atómico con un mensaje claro en español que explique el **"por qué"** del cambio, no solo el "qué":
```bash
git commit -m "tipo(alcance): descripción clara explicando la razón del cambio"
```
*Ejemplos*:
- `fix(sync): corregir desfase de reloj con sellarParaServidor para evitar rechazos en clientes con hora atrasada`
- `refactor(cascade): unificar cálculo de capacidadResizeWeekly para empuje transitivo en semana`
- `docs(agents): reorganizar AGENTS.md jerárquico y crear skills operativas`

### Paso 5: Doble Push a Repositorio Remoto
1. Empujar la rama principal a `main` (lo que dispara el despliegue automático en Vercel):
   ```bash
   git push origin main
   ```
2. Empujar en espejo a la rama `feat/cloud-sync`:
   ```bash
   git push origin main:feat/cloud-sync
   ```

### Paso 6: Verificación de Alineación Remota
Comprueba que ambas ramas remotas apunten exactamente al nuevo commit generado:
```bash
git ls-remote origin refs/heads/main refs/heads/feat/cloud-sync
```
- Ambas referencias deben mostrar el mismo hash SHA de commit.

---

## Manejo de Reglas de Zona Roja

Si los cambios modifican:
- `src/server/schema.ts` o migraciones Drizzle (`drizzle-kit push`).
- Credenciales, tokens, hashing scrypt o cookies de autenticación (`src/server/auth.ts`).
- Algoritmo de cursor `lastPushAt` o resolución LWW en `src/lib/sync.ts`.

**Acción obligatoria**: Pausar la ejecución, advertir el riesgo potencial al usuario y solicitar confirmación explícita antes de ejecutar el push a producción.
