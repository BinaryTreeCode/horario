<svelte:options runes={true} />
<script>
  import { initDB } from "../lib/db";
  import { iniciarIdioma } from "../lib/i18n";

  // Single entry point for initialization
  if (typeof window !== "undefined") {
    initDB()
      .then(() => iniciarIdioma()) // preferencia de idioma tras abrir la BD
      .catch(console.error);
  }
</script>
