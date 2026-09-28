<svelte:options runes={true} />
<script>
  import { initDB } from "../lib/db";
  import { iniciarIdioma } from "../lib/i18n";
  import { iniciarPrivacidad } from "../lib/privacy";
  import { restorePushPause } from "../lib/sync";

  // Single entry point for initialization
  if (typeof window !== "undefined") {
    initDB()
      .then(() => restorePushPause()) // pausa de push tras import: persiste entre sesiones
      .then(() => iniciarIdioma()) // preferencia de idioma tras abrir la BD
      .then(() => iniciarPrivacidad()) // modo privacidad recordado entre sesiones
      .catch(console.error);
  }
</script>
