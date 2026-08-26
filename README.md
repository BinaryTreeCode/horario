# Astro Starter Kit: Minimal

```sh
bun create astro@latest -- --template minimal
```

> 🧑‍🚀 **Seasoned astronaut?** Delete this file. Have fun!

## 🚀 Project Structure

Inside of your Astro project, you'll see the following folders and files:

```text
/
├── public/
├── src/
│   └── pages/
│       └── index.astro
└── package.json
```

Astro looks for `.astro` or `.md` files in the `src/pages/` directory. Each page is exposed as a route based on its file name.

There's nothing special about `src/components/`, but that's where we like to put any Astro/React/Vue/Svelte/Preact components.

Any static assets, like images, can be placed in the `public/` directory.

## 🚀 Stack Tecnológico Confirmado
Este proyecto utiliza tecnologías de vanguardia para garantizar el máximo rendimiento:
- **Astro 6.x** (Configurado como SPA)
- **Vite 8.x** (Con **Rolldown** y **LightningCSS** para builds ultra-rápidos en Rust)
- **Svelte 5.x** (Sistema de Runes: `$state`, `$derived`, `$props`)
- **Bun** (Runtime y gestor de paquetes de alto rendimiento)
- **Dexie.js 4.x** (Capa sobre IndexedDB para persistencia local)

## 💡 Notas de Desarrollo
Para que el build de producción funcione correctamente:
- **SSR Bypass**: Los componentes que interactúan con IndexedDB (como `Dashboard` e `InitDB`) deben invocarse con `client:only="svelte"` en las páginas de Astro. Esto evita que Node.js intente ejecutar código de navegador durante la fase de prerenderización.
- **Optimizaciones**: Se ha forzado el uso de **Rolldown** (sustituto experimental de esbuild/rollup escrito en Rust) y **LightningCSS** para la minificación, aprovechando las capacidades de Vite 8.

## 🧞 Comandos
Todos los comandos se ejecutan desde la raíz del proyecto:
- `bun dev`: Inicia el servidor de desarrollo en `localhost:4321`.
- `bun run build`: Genera el sitio de producción en la carpeta `dist/`.
- `bun run preview`: Previsualiza el build de producción localmente.

---
*Diseñado para una experiencia de usuario fluida y un desarrollo de alto rendimiento.*
