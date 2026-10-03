<svelte:options runes={true} />
<script>
  import { initDB } from "../lib/db";
  import { iniciarIdioma } from "../lib/i18n";
  import { iniciarPrivacidad } from "../lib/privacy";
  import { installSyncListeners, restorePushPause, arrancarSync } from "../lib/sync";

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
      // La cookie de sesión vive 30 días: casi ninguna sesión pasa por el login
      // interactivo, así que el motor de nube solo arranca aquí. Sin esto el
      // estado se quedaba en 'local' y ningún cambio local llegaba a la nube
      // entre sesiones (el push solo ocurría al botón de Ajustes).
      .then(() => arrancarSync())
      .catch(console.error);
  }
</script>
