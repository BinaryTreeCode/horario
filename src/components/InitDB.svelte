<svelte:options runes={true} />
<script>
  import { initDB } from "../lib/db";
  import { iniciarIdioma } from "../lib/i18n";
  import { iniciarPrivacidad } from "../lib/privacy";
  import { installSyncListeners, restorePushPause } from "../lib/sync";

  // Single entry point for initialization
  if (typeof window !== "undefined") {
    initDB()
      .then(() => restorePushPause()) // pausa de push tras import: persiste entre sesiones
      // Registra los hooks de Dexie que disparan scheduleSync y los listeners
      // de online/visibility. Sin esto el push solo ocurre al iniciar sesión,
      // tras un import o a mano: una edición normal nunca llegaba a la nube.
      // Va despues de initDB porque los hooks necesitan la BD abierta.
      .then(() => installSyncListeners())
      .then(() => iniciarIdioma()) // preferencia de idioma tras abrir la BD
      .then(() => iniciarPrivacidad()) // modo privacidad recordado entre sesiones
      .catch(console.error);
  }
</script>
