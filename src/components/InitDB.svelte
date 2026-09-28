<svelte:options runes={true} />
<script>
  import { initDB } from "../lib/db";
  import { iniciarIdioma } from "../lib/i18n";
  import { iniciarPrivacidad } from "../lib/privacy";

  // Single entry point for initialization
  if (typeof window !== "undefined") {
    initDB()
      .then(() => iniciarIdioma()) // preferencia de idioma tras abrir la BD
      .then(() => iniciarPrivacidad()) // modo privacidad recordado entre sesiones
      .catch(console.error);
  }
</script>
