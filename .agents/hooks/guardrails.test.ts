import { describe, expect, it } from 'bun:test';
import { evaluarComando, limpiarMensajesGit } from './pre-command';
import {
  analizarContenidoSvelte,
  detectarZonasRojas,
  parsearGitPorcelain,
} from './workspace-check';
import { SESSION_START_PAYLOAD } from './session-start';
import { leerStdin } from './shared';

describe('Helper compartido: leerStdin', () => {
  it('está exportado como función', () => {
    expect(typeof leerStdin).toBe('function');
  });
});

describe('Hook SessionStart: SESSION_START_PAYLOAD', () => {
  it('contiene la estructura correcta del contrato SessionStart', () => {
    expect(SESSION_START_PAYLOAD).toHaveProperty('injectSteps');
    expect(SESSION_START_PAYLOAD.injectSteps).toHaveLength(1);
    expect(SESSION_START_PAYLOAD.injectSteps[0]).toHaveProperty('systemMessage');
    const msg = SESSION_START_PAYLOAD.injectSteps[0].systemMessage.systemMessage;
    expect(msg).toContain('Nature Planner: 100% bun (nunca npm)');
    expect(msg).toContain('Zonas Rojas');
    expect(msg).toContain('src/server/schema.ts');
  });
});

describe('Hook PreToolUse: limpiarMensajesGit', () => {
  it('elimina contenidos de banderas -m simples y compuestas', () => {
    expect(limpiarMensajesGit('git commit -m "bloquear npm"')).not.toContain('npm');
    expect(limpiarMensajesGit("git commit -m 'usar cat .env.local'")).not.toContain('.env.local');
    expect(limpiarMensajesGit('git commit -am "fix npx issues"')).not.toContain('npx');
    expect(limpiarMensajesGit('git commit --message="bloquear npm"')).not.toContain('npm');
    expect(
      limpiarMensajesGit('git commit -m "primer mensaje" -m "segundo con npm"')
    ).not.toContain('npm');
    expect(limpiarMensajesGit('git tag -a v1.0.0 -m "release sin npm"')).not.toContain('npm');
    // Verifica que comandos con guión como get-childitem NO se rompan
    expect(limpiarMensajesGit('get-childitem env:DATABASE_URL')).toContain('DATABASE_URL');
  });
});

describe('Hook PreToolUse: evaluarComando', () => {
  describe('Regla DENY: Prohibir npm y npx', () => {
    it('bloquea invocaciones directas de npm', () => {
      expect(evaluarComando('npm install').decision).toBe('deny');
      expect(evaluarComando('npm test').decision).toBe('deny');
      expect(evaluarComando('npm run build').decision).toBe('deny');
      expect(evaluarComando('npm').decision).toBe('deny');
    });

    it('bloquea invocaciones directas de npx', () => {
      expect(evaluarComando('npx vitest').decision).toBe('deny');
      expect(evaluarComando('npx playwright test').decision).toBe('deny');
      expect(evaluarComando('npx').decision).toBe('deny');
    });

    it('bloquea ejecutables con extensiones en Windows (.cmd, .exe)', () => {
      expect(evaluarComando('npm.cmd install').decision).toBe('deny');
      expect(evaluarComando('npx.exe prisma').decision).toBe('deny');
    });

    it('bloquea npm/npx tras cmd /c o powershell -c', () => {
      expect(evaluarComando('cmd /c npm run dev').decision).toBe('deny');
      expect(evaluarComando('cmd.exe /c npx tailwindcss').decision).toBe('deny');
      expect(evaluarComando('powershell -Command "npm test"').decision).toBe('deny');
    });

    it('bloquea npm/npx en secuencias encadenadas (&, &&, ;, |)', () => {
      expect(evaluarComando('& npm start').decision).toBe('deny');
      expect(evaluarComando('bun test && npm test').decision).toBe('deny');
      expect(evaluarComando('bun run build; npx test').decision).toBe('deny');
      expect(evaluarComando('cat foo | npm publish').decision).toBe('deny');
      expect(evaluarComando('(npm run test)').decision).toBe('deny');
    });

    it('NO bloquea pnpm ni confunde subcadenas', () => {
      expect(evaluarComando('pnpm install').decision).toBe('ask');
      expect(evaluarComando('pnpm run build').decision).toBe('ask');
      expect(evaluarComando('pnpm.cmd test').decision).toBe('ask');
      expect(evaluarComando('echo npm').decision).toBe('ask');
      expect(evaluarComando('echo npx').decision).toBe('ask');
      expect(evaluarComando('bunx npm-check-updates').decision).toBe('ask');
    });

    it('NO genera falsos positivos en mensajes de git commit o tag', () => {
      expect(evaluarComando('git commit -m "bloquear npm y npx"').decision).toBe('ask');
      expect(evaluarComando("git commit -m 'eliminar npm de ci'").decision).toBe('ask');
      expect(evaluarComando('git commit --message "migrar npm a bun"').decision).toBe('ask');
      expect(evaluarComando('git commit -am "fix npm script"').decision).toBe('ask');
      expect(evaluarComando('git tag -a v1.0.0 -m "release sin npm"').decision).toBe('ask');
    });
  });

  describe('Regla DENY: Proteger .env.local y DATABASE_URL', () => {
    it('bloquea comandos shell que lean .env.local', () => {
      expect(evaluarComando('cat .env.local').decision).toBe('deny');
      expect(evaluarComando('type .env.local').decision).toBe('deny');
      expect(evaluarComando('Get-Content .env.local').decision).toBe('deny');
      expect(evaluarComando('get-content -Path .env.local').decision).toBe('deny');
      expect(evaluarComando('gc .env.local').decision).toBe('deny');
      expect(evaluarComando('more .env.local').decision).toBe('deny');
      expect(evaluarComando('less .env.local').decision).toBe('deny');
      expect(evaluarComando('head -n 10 .env.local').decision).toBe('deny');
      expect(evaluarComando('tail .env.local').decision).toBe('deny');
      expect(evaluarComando('select-string DATABASE_URL .env.local').decision).toBe('deny');
      expect(evaluarComando('grep DATABASE_URL .env.local').decision).toBe('deny');
      expect(evaluarComando('rg SECRET .env.local').decision).toBe('deny');
      expect(evaluarComando("sed '' .env.local").decision).toBe('deny');
      expect(evaluarComando("awk '{print}' .env.local").decision).toBe('deny');
      expect(evaluarComando('cmd < .env.local').decision).toBe('deny');
    });

    it('bloquea lecturas programáticas de .env.local (Bun.file, readFileSync, readFile)', () => {
      expect(evaluarComando("bun -e \"await Bun.file('.env.local').text()\"").decision).toBe('deny');
      expect(evaluarComando("node -e \"fs.readFileSync('.env.local')\"").decision).toBe('deny');
      expect(evaluarComando("node -e \"fs.readFile('.env.local', () => {})\"").decision).toBe('deny');
    });

    it('PERMITE operaciones seguras sobre .env.local (copia a worktrees o existencia)', () => {
      expect(evaluarComando('cp .env.local ../worktree/.env.local').decision).toBe('ask');
      expect(evaluarComando('Copy-Item .env.local -Destination ../worktree/').decision).toBe('ask');
      expect(evaluarComando('Test-Path .env.local').decision).toBe('ask');
      expect(evaluarComando('cat .env.local.example').decision).toBe('ask');
    });

    it('bloquea la impresión o exposición de DATABASE_URL', () => {
      expect(evaluarComando('echo $DATABASE_URL').decision).toBe('deny');
      expect(evaluarComando('echo %DATABASE_URL%').decision).toBe('deny');
      expect(evaluarComando('echo DATABASE_URL').decision).toBe('deny');
      expect(evaluarComando('Write-Output $env:DATABASE_URL').decision).toBe('deny');
      expect(evaluarComando('Write-Host $DATABASE_URL').decision).toBe('deny');
      expect(evaluarComando('printenv DATABASE_URL').decision).toBe('deny');
      expect(evaluarComando('gci env:DATABASE_URL').decision).toBe('deny');
      expect(evaluarComando('get-childitem env:DATABASE_URL').decision).toBe('deny');
      expect(evaluarComando('dir env:DATABASE_URL').decision).toBe('deny');
      expect(evaluarComando('Get-ChildItem env: | grep DATABASE_URL').decision).toBe('deny');
    });

    it('NO genera falsos positivos de .env.local en git commit', () => {
      expect(evaluarComando('git commit -m "proteger cat .env.local"').decision).toBe('ask');
      expect(evaluarComando('git commit -m "echo DATABASE_URL test"').decision).toBe('ask');
    });
  });

  describe('Regla FORCE_ASK: Operaciones críticas', () => {
    it('fuerza confirmación para drizzle-kit push y db:push', () => {
      expect(evaluarComando('bunx drizzle-kit push').decision).toBe('force_ask');
      expect(evaluarComando('bun run db:push').decision).toBe('force_ask');
      expect(evaluarComando('drizzle-kit push').decision).toBe('force_ask');
    });

    it('fuerza confirmación para git push forzado (-f, --force, +ref)', () => {
      expect(evaluarComando('git push origin main --force').decision).toBe('force_ask');
      expect(evaluarComando('git push origin main -f').decision).toBe('force_ask');
      expect(evaluarComando('git push -f').decision).toBe('force_ask');
      expect(evaluarComando('git push --force').decision).toBe('force_ask');
      expect(evaluarComando('git push origin +main').decision).toBe('force_ask');
    });

    it('fuerza confirmación para git reset --hard', () => {
      expect(evaluarComando('git reset --hard').decision).toBe('force_ask');
      expect(evaluarComando('git reset --hard HEAD~1').decision).toBe('force_ask');
    });

    it('NO da falso positivo en comandos encadenados que solo mencionan push -f en echo u otro comando', () => {
      expect(evaluarComando('git status && echo push -f').decision).toBe('ask');
      expect(evaluarComando('git status ; echo push --force').decision).toBe('ask');
      expect(evaluarComando('git log | grep "push -f"').decision).toBe('ask');
      expect(evaluarComando('git status && echo reset --hard').decision).toBe('ask');
    });

    it('SÍ da force_ask cuando el git push forzado real está encadenado', () => {
      expect(evaluarComando('git status && git push -f').decision).toBe('force_ask');
      expect(evaluarComando('git status ; git reset --hard').decision).toBe('force_ask');
    });
  });

  describe('Regla ASK: Comandos ordinarios de desarrollo', () => {
    it('retorna ask para comandos comunes de bun y git', () => {
      expect(evaluarComando('bun test').decision).toBe('ask');
      expect(evaluarComando('bun run build').decision).toBe('ask');
      expect(evaluarComando('bun run dev').decision).toBe('ask');
      expect(evaluarComando('git status').decision).toBe('ask');
      expect(evaluarComando('git add .').decision).toBe('ask');
      expect(evaluarComando('git diff').decision).toBe('ask');
      expect(evaluarComando('git push origin main').decision).toBe('ask');
      expect(evaluarComando('git reset HEAD~1').decision).toBe('ask');
      expect(evaluarComando('').decision).toBe('ask');
    });
  });
});

describe('Hook PreInvocation: parsearGitPorcelain', () => {
  it('retorna array vacío para salida vacía', () => {
    expect(parsearGitPorcelain('')).toEqual([]);
    expect(parsearGitPorcelain('   \n  ')).toEqual([]);
  });

  it('extrae rutas de archivos modificados, agregados o untracked', () => {
    const salida = [
      ' M src/components/Semana.svelte',
      'M  src/lib/sync.ts',
      '?? src/Nuevo.svelte',
      'A  src/pages/index.astro',
      'D  src/borrado.ts',
    ].join('\n');

    expect(parsearGitPorcelain(salida)).toEqual([
      'src/components/Semana.svelte',
      'src/lib/sync.ts',
      'src/Nuevo.svelte',
      'src/pages/index.astro',
      'src/borrado.ts',
    ]);
  });

  it('maneja renombrados tomando la ruta de destino', () => {
    const salida = 'R  src/Viejo.svelte -> src/Nuevo.svelte';
    expect(parsearGitPorcelain(salida)).toEqual(['src/Nuevo.svelte']);
  });

  it('desenvuelve rutas entre comillas y normaliza backslashes de Windows', () => {
    const salida = [
      'RM "src/espacio a.svelte" -> "src/espacio b.svelte"',
      ' M src\\components\\Dia.svelte',
    ].join('\n');

    expect(parsearGitPorcelain(salida)).toEqual([
      'src/espacio b.svelte',
      'src/components/Dia.svelte',
    ]);
  });
});

describe('Hook PreInvocation: detectarZonasRojas', () => {
  it('detecta los 5 archivos críticos de Zona Roja', () => {
    const rutas = [
      'src/server/schema.ts',
      'src/server/auth.ts',
      'src/pages/api/auth.ts',
      'src/lib/sync.ts',
      'src/pages/api/sync.ts',
    ];
    expect(detectarZonasRojas(rutas).sort()).toEqual(rutas.sort());
  });

  it('ignora archivos fuera de Zona Roja', () => {
    const rutas = [
      'src/components/Semana.svelte',
      'src/lib/toast.ts',
      'src/server/db.ts',
      'README.md',
    ];
    expect(detectarZonasRojas(rutas)).toEqual([]);
  });

  it('normaliza rutas con ./ o backslashes y deduplica', () => {
    const rutas = [
      './src/server/schema.ts',
      'src\\server\\schema.ts',
      'src/lib/sync.ts',
    ];
    expect(detectarZonasRojas(rutas).sort()).toEqual([
      'src/lib/sync.ts',
      'src/server/schema.ts',
    ]);
  });
});

describe('Hook PreInvocation: analizarContenidoSvelte', () => {
  it('detecta patrones prohibidos de Svelte 4 / legacy en <script> y template', () => {
    const svelte = `
<script lang="ts">
  export let item;
  const dispatch = createEventDispatcher();
  function aviso() {
    alert("hola");
    confirm("seguro?");
  }
</script>
<div>
  <svelte:component this={item} />
</div>
`;
    const avisos = analizarContenidoSvelte('src/Test.svelte', svelte);
    expect(avisos.some((a) => a.includes("'export let'"))).toBe(true);
    expect(avisos.some((a) => a.includes("'createEventDispatcher'"))).toBe(true);
    expect(avisos.some((a) => a.includes("'<svelte:component'"))).toBe(true);
    expect(avisos.some((a) => a.includes("'alert()'"))).toBe(true);
    expect(avisos.some((a) => a.includes("'confirm()'"))).toBe(true);
  });

  it('ignora comentarios de una línea // ... en <script>', () => {
    const svelte = `
<script lang="ts">
  // export let item;
  // createEventDispatcher();
  // alert('test');
  // confirm('test');
  let { item } = $props();
</script>
`;
    const avisos = analizarContenidoSvelte('src/Test.svelte', svelte);
    expect(avisos).toEqual([]);
  });

  it('no mutila URLs con https:// y detecta llamadas en la misma línea', () => {
    const svelteUrlYAlerta = `
<script lang="ts">
  const url = "https://x.com"; alert("y");
</script>
`;
    const avisos = analizarContenidoSvelte('src/Url.svelte', svelteUrlYAlerta);
    expect(avisos.some((a) => a.includes("'alert()'"))).toBe(true);
  });

  it('detecta violaciones de tokens de estilo en <style>', () => {
    const svelteHex = `<style>.card { color: #fff; }</style>`;
    expect(analizarContenidoSvelte('src/A.svelte', svelteHex).some((a) => a.includes('hexadecimales'))).toBe(true);

    const svelteRgba = `<style>.card { background: rgba(0, 0, 0, 0.5); }</style>`;
    expect(analizarContenidoSvelte('src/B.svelte', svelteRgba).some((a) => a.includes("'rgba()'"))).toBe(true);

    const svelteRgbSinToken = `<style>.card { color: rgb(255, 0, 0); }</style>`;
    expect(analizarContenidoSvelte('src/C.svelte', svelteRgbSinToken).some((a) => a.includes("'rgb()' sin tokens"))).toBe(true);

    const svelteWhite = `<style>.card { color: white; }</style>`;
    expect(analizarContenidoSvelte('src/D.svelte', svelteWhite).some((a) => a.includes("'white'"))).toBe(true);

    const svelteBlack = `<style>.card { background: black; }</style>`;
    expect(analizarContenidoSvelte('src/E.svelte', svelteBlack).some((a) => a.includes("'black'"))).toBe(true);
  });

  it('acepta correctamente tokens CSS con rgb(var(--token) / alfa)', () => {
    const svelteValido = `
<script lang="ts">
  let { titulo } = $props();
</script>

<div class="card">{titulo}</div>

<style>
  .card {
    background: rgb(var(--sup) / 0.9);
    color: rgb(var(--texto));
    border: 1px solid rgb(var(--borde) / 0.3);
  }
</style>
`;
    const avisos = analizarContenidoSvelte('src/Valido.svelte', svelteValido);
    expect(avisos).toEqual([]);
  });

  it('ignora comentarios /* ... */ en <style>', () => {
    const svelteConComentario = `
<style>
  /* #fff fallback obsoleto */
  /* color: white; */
  .card {
    color: rgb(var(--texto));
  }
</style>
`;
    const avisos = analizarContenidoSvelte('src/Comentario.svelte', svelteConComentario);
    expect(avisos).toEqual([]);
  });
});
