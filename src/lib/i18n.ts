/**
 * i18n mínimo del planificador — español (por defecto) + inglés.
 *
 * Diseño: catálogo plano de claves → texto, función `t(clave)` reactiva (Svelte
 * store: cambiar el idioma re-renderiza sin recargar). El idioma elegido se
 * persiste en la tabla settings de IndexedDB (viaja en el sync como el resto
 * de ajustes) y si no hay preferencia guardada se usa el del navegador.
 *
 * Convenciones:
 *  - Claves en inglés-máquina dot.case por módulo: 'header.newActivity', 'week.title'…
 *  - {placeholders} interpolados: t('week.hoursToday', { h: '13.5' }).
 *  - Falta de clave → devuelve la clave misma (fail-visible en dev, nunca crash).
 *  - Los nombres de días SIEMPRE salen del catálogo (es/en distintos).
 */

import { writable, derived, get } from 'svelte/store';
import { db, now } from './db';

export type Idioma = 'es' | 'en';

type Catalogo = Record<string, string>;

const es: Catalogo = {
  // ── Header / shell ──
  'app.name': 'Nature Planner',
  'header.week': 'Semana',
  'header.day': 'Día',
  'header.adjustUp': 'Ajustar Arriba',
  'header.adjustUpTitle': 'Ajusta todas las actividades para cubrir el espacio superior sobrante',
  'header.newActivity': 'Nueva Actividad',
  'header.settings': 'Abrir ajustes',
  'header.viewWeek': 'Ver semana',
  'header.viewDay': 'Ver día',

  // ── Días ──
  'day.0': 'Lunes',
  'day.1': 'Martes',
  'day.2': 'Miércoles',
  'day.3': 'Jueves',
  'day.4': 'Viernes',
  'day.5': 'Sábado',
  'day.6': 'Domingo',

  // ── Vista Semana ──
  'week.scrollHint': 'Deslizá para ver los días →',
  'week.viewDay': 'Ver {day} en vista de día',
  'week.tempBadge': 'Tiene edición temporal activa en la vista diaria',
  'week.hoursToday': 'Horas Hoy',
  'week.hoursWeek': 'Horas Semana',
  'week.hoursTodayAria': 'Distribución de horas de hoy por categoría',
  'week.hoursWeekAria': 'Distribución de horas de la semana por categoría',

  // ── Vista Día ──
  'dayView.empty': 'Día libre — tocá cualquier hueco del horario para crear una actividad',
  'dayView.dragHint': 'Arrastrar o tocar para editar',
  'dayView.edit': 'Editar {name}',
  'dayView.viewImage': 'Ver imagen de {name}',
  'dayView.steps': '{done} de {total} pasos',
  'dayView.keyboardHint': 'Flechas arriba/abajo para mover, Enter para editar',
  'dayView.tempMode': 'Solo este día',
  'dayView.templateMode': 'Plantilla semanal',
  'dayView.tempBanner': '⚡ Cambios temporales activos',
  'dayView.restore': 'Restaurar',
  'dayView.applyWeek': 'Aplicar a semana',
  'dayView.moveIn': 'Mover en {day}',
  'dayView.insertHere': 'Insertar aquí',
  'dayView.limitedBy': 'Limitado por {what}',

  // ── Menú contextual ──
  'menu.duplicate': 'Duplicar (Independiente)',
  'menu.viewImage': 'Ver imagen',
  'menu.delete': 'Eliminar',

  // ── Modales / confirmaciones ──
  'confirm.deleteTitle': 'Eliminar actividad',
  'confirm.deleteWeekMsg': 'La actividad se eliminará de toda la semana (y de las ediciones temporales). Esta acción no se puede deshacer.',
  'confirm.deleteDayMsg': '¿Eliminar esta actividad del día? Esta acción no se puede deshacer.',
  'confirm.deleteBtn': 'Eliminar',
  'confirm.cancel': 'Cancelar',
  'confirm.restoreTemplateTitle': 'Restaurar plantilla',
  'confirm.restoreTemplateMsg': '¿Restaurar la plantilla por defecto para este día? Se perderán los cambios temporales.',
  'confirm.applyTemplateTitle': 'Aplicar como plantilla semanal',
  'confirm.applyTemplateMsg': '¿Aplicar estos cambios temporales como la plantilla semanal permanente? Reemplazará las actividades de este día en toda la semana.',
  'confirm.applyBtn': 'Aplicar',
  'confirm.close': 'Cerrar aviso',

  // ── Toasts ──
  'toast.saved': 'Actividad guardada ✓',
  'toast.created': 'Actividad creada ✓',
  'toast.deleted': 'Actividad eliminada',
  'toast.duplicated': '{name} → {time}',
  'toast.noGap': 'No hay hueco libre para duplicar',
  'toast.templateRestored': 'Plantilla restaurada',
  'toast.appliedWeek': 'Aplicado a la plantilla semanal',
  'toast.couldNotMove': 'No se pudo mover',
  'toast.noFit': '⛔ No cabe: el empuje desbordaría el día',
  'toast.wiped': 'Todos los datos fueron borrados',
  'toast.undone': 'Deshecho: {label}',
  'toast.couldNotDelete': 'No se pudo eliminar',
  'toast.quotaPaused': '⚠️ Respaldo automático pausado: localStorage lleno. Tus datos siguen intactos en la base principal. Usa "Exportar JSON" (Ajustes) o inicia sesión para respaldar en la nube.',

  // ── Ajustes ──
  'settings.title': 'Configuración',
  'settings.account': 'Cuenta y respaldo en la nube',
  'settings.checkingSession': 'Comprobando sesión…',
  'settings.synced': 'Sincronizado con la nube',
  'settings.syncing': 'Sincronizando…',
  'settings.syncError': 'Error de sincronización',
  'settings.offline': 'Sin conexión — cambios guardados localmente',
  'settings.localOnly': 'Solo local (sin respaldo en la nube)',
  'settings.syncNow': 'Sincronizar ahora',
  'settings.logout': 'Cerrar sesión',
  'settings.loginPrompt': 'Crea una cuenta o inicia sesión para respaldar tus datos y sincronizarlos entre dispositivos. Todo sigue funcionando offline.',
  'settings.login': 'Iniciar sesión',
  'settings.register': 'Crear cuenta',
  'settings.nameOptional': 'Nombre (opcional)',
  'settings.email': 'Email',
  'settings.password': 'Contraseña (mín. 8 caracteres)',
  'settings.enter': 'Entrar',
  'settings.createAccount': 'Crear cuenta',
  'settings.language': 'Idioma / Language',
  'settings.languageHint': 'Se aplica al instante y queda guardado en este dispositivo.',
  'settings.hoursRange': 'Límites del Horario (Rango diario)',
  'settings.backup': 'Respaldo y datos',
  'settings.exportJson': 'Exportar JSON',
  'settings.importJson': 'Importar JSON',
  'settings.file': 'Archivo: {name}',
  'settings.wipeAll': 'Borrar todo',
  'settings.wipeAllLabel': 'Borrar todos los datos: actividades, categorías y ediciones temporales',
  'settings.backupInfo': 'Exporta actividades, categorías, ediciones temporales e imágenes para respaldarlas o moverlas a otro navegador. Al importar se te pedirá confirmación y verás un resumen antes de reemplazar tus datos.',
  'settings.dataTitle': 'Tus datos, en claro',
  'settings.saveAll': 'Guardar Todo',
  'settings.cancel': 'Cancelar',
  'settings.logoutShort': 'Salir',
  'settings.startsAt': 'Empieza a las:',
  'settings.endsAt': 'Termina a las:',
  'settings.to': 'a las',
  'settings.daySummary': 'Tu día tiene {hours} horas de planificación.',
  'settings.categories': 'Categorías',
  'settings.addCategory': 'Añadir nueva categoría',
  'settings.colorOf': 'Color de {name}',
  'settings.categoryName': 'Nombre de la categoría',
  'settings.removeCategory': 'Quitar la categoría {name}',
  'settings.newCategory': 'Nueva Categoría',
  'settings.saved': 'Ajustes guardados ✓',
  'settings.saveError': 'Error al guardar: {msg}',
  'settings.removedCats': 'Categorías eliminadas: {names}. Sus actividades ahora pertenecen a "Rutina".',
  'settings.catsReset': 'Categorías restablecidas — pulsa Guardar Todo para aplicar',
  'settings.resetCatsTitle': 'Restablecer categorías',
  'settings.resetCatsMsg': '¿Restablecer todas las categorías a las originales? Los cambios no se aplican hasta que pulses Guardar Todo.',
  'settings.resetBtn': 'Restablecer',
  'settings.importTitle': '¿Importar este archivo?',
  'settings.importMsg': 'REEMPLAZARÁ TODOS tus datos actuales por el contenido del archivo:\n\n{summary}{warnings}\n\nEsta acción no se puede deshacer.',
  'settings.importWarnings': '\n\n⚠️ Advertencias:\n• {list}',
  'settings.importBtn': 'Importar',
  'settings.moreWarnings': '… y {count} advertencias más',
  'settings.importedSynced': 'Datos importados y sincronizados con la nube ✓',
  'settings.importedLocal': 'Datos importados en este dispositivo. La subida a la nube falló — reintenta desde el banner de sincronización.',
  'settings.imported': 'Datos importados con éxito ✓',
  'settings.importError': 'Error al importar: {msg}',
  'settings.fileTooBig': 'El archivo es demasiado grande ({size} MB). El límite es {max} MB.',
  'settings.fileReadError': 'No se pudo leer el archivo. Verifica que exista y que tengas permisos sobre él.',
  'settings.importFailed': 'No se pudo importar:\n{error}',
  'settings.summaryActs': 'Actividades: {n}',
  'settings.summaryCats': 'Categorías: {n}',
  'settings.summarySettings': 'Ajustes: {n}',
  'settings.summaryOverrides': 'Ediciones temporales por día: {n}',
  'settings.exportError': 'Error al exportar: {msg}',
  'settings.wipeTitle': '¿Borrar TODOS los datos?',
  'settings.wipeMsg': 'Se eliminarán TODAS las actividades, categorías y ediciones temporales de este dispositivo (el horario vuelve a 7:00–23:00).\n\nSi tienes sesión iniciada, el borrado también se sincronizará con la nube.\n\nEsta acción no se puede deshacer — exporta un respaldo antes si lo necesitas.',
  'settings.wipeError': 'No se pudo borrar: {msg}',
  'settings.authError': 'Error de autenticación',
  'settings.networkError': 'Error de red',
  'settings.syncingMsg': 'Sincronizando…',
  'settings.syncedE2E': '✅ Sincronizado con la nube (cifrado E2E)',
  'settings.syncedMsg': '✅ Sincronizado',
  'settings.syncFail': '⚠️ {msg}',
  'settings.syncFailGeneric': 'Error de sync',
  'settings.closeSettings': 'Cerrar ajustes',

  // ── Transparencia de datos ──
  'privacy.noAccount': '<strong>Sin cuenta:</strong> todo vive <strong>solo en este navegador</strong> (IndexedDB). Nunca sale de tu dispositivo — funciona igual con o sin internet.',
  'privacy.withAccount': '<strong>Con cuenta:</strong> tu horario se respalda en la nube para sincronizar dispositivos, cifrado de extremo a extremo. <strong>No se comparte con terceros, no hay analítica ni rastreadores</strong>.',
  'privacy.whatWeStore': '<strong>Lo que se guarda:</strong> actividades, horarios, pasos, categorías, ediciones temporales y las imágenes que tú subas. <strong>Nada más.</strong>',
  'privacy.youControl': '<strong>Tú tienes el control:</strong> exporta todo cuando quieras (JSON), y "Borrar todo" elimina local + nube de verdad.',
  'privacy.noFinePrint': '<strong>Sin letra chica:</strong> no vendemos datos, no hay publicidad, no hay perfiles de usuario.',

  // ── ActivityModal (lo esencial) ──
  'modal.newTitle': 'Nueva Actividad',
  'modal.editTitle': 'Editar Actividad',
  'modal.namePlaceholder': 'Ej. Rutina Matutina',
  'modal.stepPlaceholder': 'Escribe un paso y presiona Enter',
  'modal.addStep': 'Agregar paso',
  'modal.save': 'Guardar',
  'modal.create': 'Crear',
  'modal.duplicate': 'Duplicar',
  'modal.nameRequired': 'Por favor selecciona una categoría y escribe un nombre',
  'modal.closeNoSave': 'Cerrar sin guardar',
  'modal.saveIn': 'Guardar en:',
  'modal.scopeDay': 'Solo este día (Temporal)',
  'modal.category': 'Categoría',
  'modal.whatToDo': '¿Qué vas a hacer?',
  'modal.routineImage': 'Imagen de la rutina',
  'modal.view': 'Ver',
  'modal.viewImageTitle': 'Ver imagen ampliada',
  'modal.removeImage': 'Quitar imagen',
  'modal.remove': 'Quitar',
  'modal.uploadFile': 'Subir archivo',
  'modal.useUrl': 'Usar URL',
  'modal.stepsCount': 'Pasos / Subtareas ({n})',
  'modal.suggestRoutine': 'Sugerir rutina',
  'modal.suggestRoutineAria': 'Sugerir pasos de rutina según la categoría',
  'modal.newStep': 'Nuevo paso',
  'modal.add': 'Añadir',
  'modal.completeStep': 'Completar paso',
  'modal.deleteStep': 'Eliminar paso',
  'modal.from': 'Desde',
  'modal.to': 'Hasta',
  'modal.toSep': 'a',
  'modal.quickAdjust': 'Ajuste rápido:',
  'modal.totalDuration': 'Duración total:',
  'modal.daysOfWeek': 'Días de la semana',
  'modal.weekdays': 'Lunes a Viernes',
  'modal.allWeek': 'Toda la semana',
  'modal.deleteTitle': 'Eliminar actividad',
  'modal.deleteMsg': '¿Eliminar esta actividad? Esta acción no se puede deshacer.',
  'modal.duplicateTitle': 'Duplicar actividad',
  'modal.duplicateMsg': 'Se creará "{name} (copia)" en el primer hueco libre de sus días ({days} día/s).',
  'modal.createdCopy': 'Creada "{name}" en el primer hueco libre ✓',
  'modal.duplicateError': 'Error al duplicar: {msg}',
  'modal.notImage': 'El archivo seleccionado no es una imagen.',
  'modal.imageTooBig': 'La imagen es muy grande (máximo 2 MB) para guardarla en la base de datos local.',
  'modal.stepsAdded': '{n} pasos sugeridos agregados',
  'modal.preset.0': 'Beber vaso con agua y estirar',
  'modal.preset.1': 'Aseo personal / Ducha',
  'modal.preset.2': 'Desayuno nutritivo',
  'modal.preset.3': 'Revisar objetivos del día',
  'modal.dayLetter.0': 'L',
  'modal.dayLetter.1': 'M',
  'modal.dayLetter.2': 'M',
  'modal.dayLetter.3': 'J',
  'modal.dayLetter.4': 'V',
  'modal.dayLetter.5': 'S',
  'modal.dayLetter.6': 'D',
  'modal.saveError': 'Error al guardar: {msg}',
};

const en: Catalogo = {
  'app.name': 'Nature Planner',
  'header.week': 'Week',
  'header.day': 'Day',
  'header.adjustUp': 'Adjust Up',
  'header.adjustUpTitle': 'Shift all activities to cover the leftover space at the top',
  'header.newActivity': 'New Activity',
  'header.settings': 'Open settings',
  'header.viewWeek': 'View week',
  'header.viewDay': 'View day',

  'day.0': 'Monday',
  'day.1': 'Tuesday',
  'day.2': 'Wednesday',
  'day.3': 'Thursday',
  'day.4': 'Friday',
  'day.5': 'Saturday',
  'day.6': 'Sunday',

  'week.scrollHint': 'Swipe to see the days →',
  'week.viewDay': 'View {day} in day view',
  'week.tempBadge': 'Has an active temporary edit in day view',
  'week.hoursToday': 'Hours Today',
  'week.hoursWeek': 'Hours This Week',
  'week.hoursTodayAria': 'Distribution of today’s hours by category',
  'week.hoursWeekAria': 'Distribution of this week’s hours by category',

  'dayView.empty': 'Free day — tap any slot in the schedule to create an activity',
  'dayView.dragHint': 'Drag or tap to edit',
  'dayView.edit': 'Edit {name}',
  'dayView.viewImage': 'View {name} image',
  'dayView.steps': '{done} of {total} steps',
  'dayView.keyboardHint': 'Arrow up/down to move, Enter to edit',
  'dayView.tempMode': 'This day only',
  'dayView.templateMode': 'Weekly template',
  'dayView.tempBanner': '⚡ Temporary changes active',
  'dayView.restore': 'Restore',
  'dayView.applyWeek': 'Apply to week',
  'dayView.moveIn': 'Move in {day}',
  'dayView.insertHere': 'Insert here',
  'dayView.limitedBy': 'Limited by {what}',

  'menu.duplicate': 'Duplicate (Independent)',
  'menu.viewImage': 'View image',
  'menu.delete': 'Delete',

  'confirm.deleteTitle': 'Delete activity',
  'confirm.deleteWeekMsg': 'The activity will be removed from the whole week (and from temporary edits). This cannot be undone.',
  'confirm.deleteDayMsg': 'Delete this activity from the day? This cannot be undone.',
  'confirm.deleteBtn': 'Delete',
  'confirm.cancel': 'Cancel',
  'confirm.restoreTemplateTitle': 'Restore template',
  'confirm.restoreTemplateMsg': 'Restore the default template for this day? Temporary changes will be lost.',
  'confirm.applyTemplateTitle': 'Apply as weekly template',
  'confirm.applyTemplateMsg': 'Apply these temporary changes as the permanent weekly template? It will replace this day\'s activities for the whole week.',
  'confirm.applyBtn': 'Apply',
  'confirm.close': 'Dismiss notice',

  'toast.saved': 'Activity saved ✓',
  'toast.created': 'Activity created ✓',
  'toast.deleted': 'Activity deleted',
  'toast.duplicated': '{name} → {time}',
  'toast.noGap': 'No free slot to duplicate',
  'toast.templateRestored': 'Template restored',
  'toast.appliedWeek': 'Applied to the weekly template',
  'toast.couldNotMove': 'Could not move',
  'toast.noFit': '⛔ Does not fit: the push would overflow the day',
  'toast.wiped': 'All data was deleted',
  'toast.undone': 'Undone: {label}',
  'toast.couldNotDelete': 'Could not delete',
  'toast.quotaPaused': '⚠️ Automatic backup paused: localStorage full. Your data remains intact in the main database. Use "Export JSON" (Settings) or log in to back up to the cloud.',

  'settings.title': 'Settings',
  'settings.account': 'Account & cloud backup',
  'settings.checkingSession': 'Checking session…',
  'settings.synced': 'Synced with the cloud',
  'settings.syncing': 'Syncing…',
  'settings.syncError': 'Sync error',
  'settings.offline': 'Offline — changes saved locally',
  'settings.localOnly': 'Local only (no cloud backup)',
  'settings.syncNow': 'Sync now',
  'settings.logout': 'Log out',
  'settings.loginPrompt': 'Create an account or log in to back up your data and sync across devices. Everything still works offline.',
  'settings.login': 'Log in',
  'settings.register': 'Create account',
  'settings.nameOptional': 'Name (optional)',
  'settings.email': 'Email',
  'settings.password': 'Password (min. 8 characters)',
  'settings.enter': 'Enter',
  'settings.createAccount': 'Create account',
  'settings.language': 'Idioma / Language',
  'settings.languageHint': 'Applies instantly and is saved on this device.',
  'settings.hoursRange': 'Schedule Limits (Daily Range)',
  'settings.backup': 'Backup & data',
  'settings.exportJson': 'Export JSON',
  'settings.importJson': 'Import JSON',
  'settings.file': 'File: {name}',
  'settings.wipeAll': 'Delete everything',
  'settings.wipeAllLabel': 'Delete all data: activities, categories and temporary edits',
  'settings.backupInfo': 'Export activities, categories, temporary edits and images to back them up or move them to another browser. On import you will be asked to confirm and will see a summary before replacing your data.',
  'settings.dataTitle': 'Your data, in plain words',
  'settings.saveAll': 'Save All',
  'settings.cancel': 'Cancel',
  'settings.logoutShort': 'Log out',
  'settings.startsAt': 'Starts at:',
  'settings.endsAt': 'Ends at:',
  'settings.to': 'to',
  'settings.daySummary': 'Your day has {hours} hours of planning.',
  'settings.categories': 'Categories',
  'settings.addCategory': 'Add new category',
  'settings.colorOf': 'Color for {name}',
  'settings.categoryName': 'Category name',
  'settings.removeCategory': 'Remove category {name}',
  'settings.newCategory': 'New Category',
  'settings.saved': 'Settings saved ✓',
  'settings.saveError': 'Error saving: {msg}',
  'settings.removedCats': 'Categories removed: {names}. Their activities now belong to "Routine".',
  'settings.catsReset': 'Categories reset — press Save All to apply',
  'settings.resetCatsTitle': 'Reset categories',
  'settings.resetCatsMsg': 'Reset all categories to the originals? Changes are not applied until you press Save All.',
  'settings.resetBtn': 'Reset',
  'settings.importTitle': 'Import this file?',
  'settings.importMsg': 'This will REPLACE ALL your current data with the file contents:\n\n{summary}{warnings}\n\nThis cannot be undone.',
  'settings.importWarnings': '\n\n⚠️ Warnings:\n• {list}',
  'settings.importBtn': 'Import',
  'settings.moreWarnings': '… and {count} more warnings',
  'settings.importedSynced': 'Data imported and synced with the cloud ✓',
  'settings.importedLocal': 'Data imported on this device. The cloud upload failed — retry from the sync banner.',
  'settings.imported': 'Data imported successfully ✓',
  'settings.importError': 'Import error: {msg}',
  'settings.fileTooBig': 'The file is too large ({size} MB). The limit is {max} MB.',
  'settings.fileReadError': 'Could not read the file. Check that it exists and you have permission over it.',
  'settings.importFailed': 'Could not import:\n{error}',
  'settings.summaryActs': 'Activities: {n}',
  'settings.summaryCats': 'Categories: {n}',
  'settings.summarySettings': 'Settings: {n}',
  'settings.summaryOverrides': 'Day temporary edits: {n}',
  'settings.exportError': 'Export error: {msg}',
  'settings.wipeTitle': 'Delete ALL data?',
  'settings.wipeMsg': 'ALL activities, categories and temporary edits will be removed from this device (schedule returns to 7:00–23:00).\n\nIf you are logged in, the deletion will also sync to the cloud.\n\nThis cannot be undone — export a backup first if you need one.',
  'settings.wipeError': 'Could not delete: {msg}',
  'settings.authError': 'Authentication error',
  'settings.networkError': 'Network error',
  'settings.syncingMsg': 'Syncing…',
  'settings.syncedE2E': '✅ Synced with the cloud (E2E encrypted)',
  'settings.syncedMsg': '✅ Synced',
  'settings.syncFail': '⚠️ {msg}',
  'settings.syncFailGeneric': 'Sync error',
  'settings.closeSettings': 'Close settings',

  'privacy.noAccount': '<strong>No account:</strong> everything lives <strong>only in this browser</strong> (IndexedDB). It never leaves your device — works the same with or without internet.',
  'privacy.withAccount': '<strong>With an account:</strong> your schedule is backed up to the cloud to sync devices, end-to-end encrypted. <strong>Not shared with third parties, no analytics, no trackers</strong>.',
  'privacy.whatWeStore': '<strong>What we store:</strong> activities, schedules, steps, categories, temporary edits and the images you upload. <strong>Nothing else.</strong>',
  'privacy.youControl': '<strong>You are in control:</strong> export everything anytime (JSON), and "Delete everything" truly removes local + cloud data.',
  'privacy.noFinePrint': '<strong>No fine print:</strong> we do not sell data, there are no ads, no user profiling.',

  'modal.newTitle': 'New Activity',
  'modal.editTitle': 'Edit Activity',
  'modal.namePlaceholder': 'e.g. Morning Routine',
  'modal.stepPlaceholder': 'Type a step and press Enter',
  'modal.addStep': 'Add step',
  'modal.save': 'Save',
  'modal.create': 'Create',
  'modal.duplicate': 'Duplicate',
  'modal.nameRequired': 'Please pick a category and type a name',
  'modal.closeNoSave': 'Close without saving',
  'modal.saveIn': 'Save to:',
  'modal.scopeDay': 'This day only (Temporary)',
  'modal.category': 'Category',
  'modal.whatToDo': 'What are you going to do?',
  'modal.routineImage': 'Routine image',
  'modal.view': 'View',
  'modal.viewImageTitle': 'View enlarged image',
  'modal.removeImage': 'Remove image',
  'modal.remove': 'Remove',
  'modal.uploadFile': 'Upload file',
  'modal.useUrl': 'Use URL',
  'modal.stepsCount': 'Steps / Subtasks ({n})',
  'modal.suggestRoutine': 'Suggest routine',
  'modal.suggestRoutineAria': 'Suggest routine steps based on the category',
  'modal.newStep': 'New step',
  'modal.add': 'Add',
  'modal.completeStep': 'Toggle step',
  'modal.deleteStep': 'Delete step',
  'modal.from': 'From',
  'modal.to': 'Until',
  'modal.toSep': 'to',
  'modal.quickAdjust': 'Quick adjust:',
  'modal.totalDuration': 'Total duration:',
  'modal.daysOfWeek': 'Days of the week',
  'modal.weekdays': 'Monday to Friday',
  'modal.allWeek': 'Whole week',
  'modal.deleteTitle': 'Delete activity',
  'modal.deleteMsg': 'Delete this activity? This cannot be undone.',
  'modal.duplicateTitle': 'Duplicate activity',
  'modal.duplicateMsg': '"{name} (copy)" will be created in the first free slot of its days ({days} day/s).',
  'modal.createdCopy': 'Created "{name}" in the first free slot ✓',
  'modal.duplicateError': 'Duplicate error: {msg}',
  'modal.notImage': 'The selected file is not an image.',
  'modal.imageTooBig': 'The image is too large (max 2 MB) to store in the local database.',
  'modal.stepsAdded': '{n} suggested steps added',
  'modal.preset.0': 'Drink a glass of water and stretch',
  'modal.preset.1': 'Personal care / Shower',
  'modal.preset.2': 'Nutritious breakfast',
  'modal.preset.3': 'Review goals for the day',
  'modal.dayLetter.0': 'M',
  'modal.dayLetter.1': 'T',
  'modal.dayLetter.2': 'W',
  'modal.dayLetter.3': 'T',
  'modal.dayLetter.4': 'F',
  'modal.dayLetter.5': 'S',
  'modal.dayLetter.6': 'S',
  'modal.saveError': 'Save error: {msg}',
};

const catalogos: Record<Idioma, Catalogo> = { es, en };

// ── Store del idioma activo ─────────────────────────────────────────────────

/** Idioma por defecto: el del navegador si empieza con 'en', si no español. */
function idiomaInicial(): Idioma {
  if (typeof navigator === 'undefined') return 'es';
  return navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'es';
}

export const idioma = writable<Idioma>('es');

/** Carga la preferencia guardada (settings de IndexedDB) y arranca el i18n. */
export async function iniciarIdioma(): Promise<void> {
  try {
    const guardado = await db.settings.get('language');
    const valor = guardado?.value as Idioma | undefined;
    idioma.set(valor === 'en' || valor === 'es' ? valor : idiomaInicial());
  } catch {
    idioma.set(idiomaInicial());
  }
}

/** Cambia el idioma y persiste la preferencia (viaja con el sync como ajuste). */
export async function cambiarIdioma(nuevo: Idioma): Promise<void> {
  idioma.set(nuevo);
  try {
    await db.settings.put({ id: 'language', key: 'language', value: nuevo, updatedAt: now() });
  } catch { /* sin BD (SSR/primer arranque): el idioma queda solo en memoria */ }
}

/** Interpolación: t('week.hoursToday') o t('toast.duplicated', { name, time }). */
function interpolar(plantilla: string, vars?: Record<string, string | number>): string {
  if (!vars) return plantilla;
  return plantilla.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

/** t() reactivo: los componentes que lo usan se re-renderizan al cambiar idioma. */
export const t = derived(idioma, (lang) => {
  const cat = catalogos[lang] ?? es;
  return (clave: string, vars?: Record<string, string | number>): string => {
    const plantilla = cat[clave] ?? es[clave] ?? clave;
    return interpolar(plantilla, vars);
  };
});

/** t() no reactivo para contextos fuera de componentes (módulos, toasts desde lib). */
export function tNow(clave: string, vars?: Record<string, string | number>): string {
  const lang = get(idioma);
  const cat = catalogos[lang] ?? es;
  return interpolar(cat[clave] ?? es[clave] ?? clave, vars);
}

/** Lista de idiomas disponibles para el selector de Ajustes (nombre nativo). */
export const IDIOMAS_DISPONIBLES: { codigo: Idioma; nombre: string }[] = [
  { codigo: 'es', nombre: 'Español' },
  { codigo: 'en', nombre: 'English' },
];
