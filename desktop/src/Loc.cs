using System;
using System.Collections.Generic;
using System.Windows.Forms;

namespace FishingbotDesktopV2
{
    // Text for the desktop window and its dialogs, in the five languages of the Control Centre.
    // English is the key. The language follows the hub's selector: i18n.js posts its code to this host
    // (WebView2 message) and MainForm passes it to SetLanguage. Log lines and error details stay English.
    internal static class Loc
    {
        private static readonly string[] Codes = { "en", "de", "es", "fr", "zh" };

        // Row layout: English, German, Spanish, French, Simplified Chinese.
        private static readonly string[][] Rows =
        {
            new[] { "START SERVER", "SERVER STARTEN", "INICIAR SERVIDOR", "DÉMARRER LE SERVEUR", "启动服务器" },
            new[] { "STOP SERVER", "SERVER STOPPEN", "DETENER SERVIDOR", "ARRÊTER LE SERVEUR", "停止服务器" },
            new[] { "RECONNECT TWITCH", "TWITCH NEU VERBINDEN", "RECONECTAR TWITCH", "RECONNECTER TWITCH", "重新连接 TWITCH" },
            new[] { "CONNECT TWITCH", "MIT TWITCH VERBINDEN", "CONECTAR TWITCH", "CONNECTER TWITCH", "连接 TWITCH" },
            new[] { "CONTROL CENTRE", "STEUERZENTRALE", "CENTRO DE CONTROL", "CENTRE DE CONTRÔLE", "控制中心" },
            new[] { "LIVE LOG", "LIVE-LOG", "REGISTRO EN VIVO", "JOURNAL EN DIRECT", "实时日志" },
            new[] { "POP OUT", "IN EIGENEM FENSTER", "SACAR A VENTANA", "DÉTACHER", "弹出窗口" },
            new[] { "CLEAR", "LEEREN", "BORRAR", "EFFACER", "清空" },
            new[] { "SERVER", "SERVER", "SERVIDOR", "SERVEUR", "服务器" },
            new[] { "TWITCH BOT", "TWITCH-BOT", "BOT DE TWITCH", "BOT TWITCH", "Twitch 机器人" },
            new[] { "RUNTIME  ·  LAST 60 MINUTES", "LAUFZEIT  ·  LETZTE 60 MINUTEN", "EJECUCIÓN  ·  ÚLTIMOS 60 MINUTOS", "EXÉCUTION  ·  60 DERNIÈRES MINUTES", "运行情况  ·  最近 60 分钟" },
            new[] { "RUNNING", "LÄUFT", "EN EJECUCIÓN", "EN COURS", "运行中" },
            new[] { "STOPPED", "GESTOPPT", "DETENIDO", "ARRÊTÉ", "已停止" },
            new[] { "SERVER OFFLINE", "SERVER OFFLINE", "SERVIDOR DESCONECTADO", "SERVEUR HORS LIGNE", "服务器离线" },
            new[] { "SERVER ONLINE", "SERVER ONLINE", "SERVIDOR EN LÍNEA", "SERVEUR EN LIGNE", "服务器在线" },
            new[] { "STARTING", "STARTET", "INICIANDO", "DÉMARRAGE", "启动中" },
            new[] { "START FAILED", "START FEHLGESCHLAGEN", "INICIO FALLIDO", "ÉCHEC DU DÉMARRAGE", "启动失败" },
            new[] { "SERVER FILE MISSING", "SERVERDATEI FEHLT", "FALTA EL ARCHIVO DEL SERVIDOR", "FICHIER SERVEUR MANQUANT", "缺少服务器文件" },
            new[] { "WAITING FOR OBS", "WARTET AUF OBS", "ESPERANDO A OBS", "EN ATTENTE D'OBS", "等待 OBS" },
            new[] { "NOT CONNECTED", "NICHT VERBUNDEN", "NO CONECTADO", "NON CONNECTÉ", "未连接" },
            new[] { "Connect from the /local page.", "Verbinde dich über die /local-Seite.", "Conecta desde la página /local.", "Connectez-vous depuis la page /local.", "请在 /local 页面中连接。" },
            new[] { "CONNECTED", "VERBUNDEN", "CONECTADO", "CONNECTÉ", "已连接" },
            new[] { "CONNECTING", "VERBINDET", "CONECTANDO", "CONNEXION", "连接中" },
            new[] { "TWITCH ERROR", "TWITCH-FEHLER", "ERROR DE TWITCH", "ERREUR TWITCH", "Twitch 错误" },
            new[] { "The local server is stopped.", "Der lokale Server ist gestoppt.", "El servidor local está detenido.", "Le serveur local est arrêté.", "本地服务器已停止。" },
            new[] { "Use START SERVER in the left panel.", "Verwende START SERVER im linken Bereich.", "Usa START SERVER en el panel izquierdo.", "Utilisez START SERVER dans le panneau de gauche.", "请使用左侧的“启动服务器”。" },
            new[] { "Starting local server...", "Lokaler Server wird gestartet...", "Iniciando el servidor local...", "Démarrage du serveur local...", "正在启动本地服务器..." },
            new[] { "Opening the Control Centre...", "Steuerzentrale wird geöffnet...", "Abriendo el centro de control...", "Ouverture du centre de contrôle...", "正在打开控制中心..." },
            new[] { "WARN", "WARN", "AVISOS", "AVERT.", "警告" },
            new[] { "ERR", "FEHLER", "ERR", "ERR", "错误" },
            new[] { "UP", "LAUF", "ACTIVO", "ACTIF", "运行" },
            new[] { "LINE", "ZEILE", "LÍNEA", "LIGNE", "行" },
            new[] { "LINES", "ZEILEN", "LÍNEAS", "LIGNES", "行" },
            new[] { "NO WARNINGS OR ERRORS IN THE LAST HOUR", "KEINE WARNUNGEN ODER FEHLER IN DER LETZTEN STUNDE", "SIN AVISOS NI ERRORES EN LA ÚLTIMA HORA", "AUCUN AVERTISSEMENT NI ERREUR DANS LA DERNIÈRE HEURE", "最近一小时没有警告或错误" },
            new[] { "SERVER STOPPED  ·  NO DATA THIS HOUR", "SERVER GESTOPPT  ·  KEINE DATEN IN DIESER STUNDE", "SERVIDOR DETENIDO  ·  SIN DATOS ESTA HORA", "SERVEUR ARRÊTÉ  ·  AUCUNE DONNÉE CETTE HEURE", "服务器已停止  ·  本小时没有数据" },
            new[] { "WARNING", "WARNUNG", "AVISO", "AVERTISSEMENT", "警告" },
            new[] { "WARNINGS", "WARNUNGEN", "AVISOS", "AVERTISSEMENTS", "警告" },
            new[] { "ERROR", "FEHLER", "ERROR", "ERREUR", "错误" },
            new[] { "ERRORS", "FEHLER", "ERRORES", "ERREURS", "错误" },
            new[] { "IN THE LAST HOUR", "IN DER LETZTEN STUNDE", "EN LA ÚLTIMA HORA", "DANS LA DERNIÈRE HEURE", "最近一小时" },
            new[] { "60 MIN AGO", "VOR 60 MIN", "HACE 60 MIN", "IL Y A 60 MIN", "60 分钟前" },
            new[] { "30 MIN", "30 MIN", "30 MIN", "30 MIN", "30 分钟" },
            new[] { "NOW", "JETZT", "AHORA", "MAINTENANT", "现在" },
            new[] { "Start the local server", "Lokalen Server starten", "Iniciar el servidor local", "Démarrer le serveur local", "启动本地服务器" },
            new[] { "Stop the local server this window started", "Den von diesem Fenster gestarteten lokalen Server stoppen", "Detener el servidor local iniciado desde esta ventana", "Arrêter le serveur local démarré par cette fenêtre", "停止此窗口启动的本地服务器" },
            new[] { "Reconnect the Twitch bot", "Twitch-Bot neu verbinden", "Reconectar el bot de Twitch", "Reconnecter le bot Twitch", "重新连接 Twitch 机器人" },
            new[] { "Desktop settings, admin password and update source", "Desktop-Einstellungen, Admin-Passwort und Update-Quelle", "Ajustes de escritorio, contraseña de administrador y origen de actualizaciones", "Réglages du bureau, mot de passe admin et source des mises à jour", "桌面设置、管理员密码和更新源" },
            new[] { "Check for a verified update", "Nach einem verifizierten Update suchen", "Buscar una actualización verificada", "Rechercher une mise à jour vérifiée", "检查已验证的更新" },
            new[] { "Show the Control Centre. Click again to reopen it.", "Steuerzentrale anzeigen. Erneut klicken, um sie neu zu öffnen.", "Muestra el centro de control. Haz clic de nuevo para reabrirlo.", "Afficher le centre de contrôle. Cliquez à nouveau pour le rouvrir.", "显示控制中心。再次点击可重新打开。" },
            new[] { "Show the live server log (Ctrl+L switches views)", "Live-Serverprotokoll anzeigen (Strg+L wechselt die Ansicht)", "Mostrar el registro en vivo (Ctrl+L cambia de vista)", "Afficher le journal en direct (Ctrl+L change de vue)", "显示实时服务器日志（Ctrl+L 切换视图）" },
            new[] { "Open the log in its own window", "Protokoll in einem eigenen Fenster öffnen", "Abrir el registro en su propia ventana", "Ouvrir le journal dans sa propre fenêtre", "在独立窗口中打开日志" },
            new[] { "Clear the log", "Protokoll leeren", "Borrar el registro", "Effacer le journal", "清空日志" },
            new[] { "Minimize", "Minimieren", "Minimizar", "Réduire", "最小化" },
            new[] { "Maximize or restore", "Maximieren oder wiederherstellen", "Maximizar o restaurar", "Agrandir ou restaurer", "最大化或还原" },
            new[] { "Close Fishingbot", "Fishingbot schließen", "Cerrar Fishingbot", "Fermer Fishingbot", "关闭 Fishingbot" },
            new[] { "Stop the local server?", "Lokalen Server stoppen?", "¿Detener el servidor local?", "Arrêter le serveur local ?", "停止本地服务器？" },
            new[] { "Stopping the server disconnects the Control Centre and any live viewers until you start it again.", "Beim Stoppen des Servers werden Steuerzentrale und alle Zuschauer getrennt, bis du ihn erneut startest.", "Detener el servidor desconecta el centro de control y a los espectadores hasta que lo vuelvas a iniciar.", "Arrêter le serveur déconnecte le centre de contrôle et les spectateurs jusqu'à ce que vous le redémarriez.", "停止服务器会断开控制中心和所有观众，直到你重新启动它。" },
            new[] { "CANCEL", "ABBRECHEN", "CANCELAR", "ANNULER", "取消" },
            new[] { "LIVE SERVER LOG  /  POPPED OUT", "LIVE-SERVERPROTOKOLL  /  IN EIGENEM FENSTER", "REGISTRO EN VIVO  /  EN VENTANA", "JOURNAL EN DIRECT  /  FENÊTRE SÉPARÉE", "实时服务器日志  /  独立窗口" },
            new[] { "RETURN TO MAIN", "ZURÜCK ZUM HAUPTFENSTER", "VOLVER A LA VENTANA PRINCIPAL", "RETOUR À LA FENÊTRE PRINCIPALE", "返回主窗口" },
            new[] { "Fishingbot update", "Fishingbot-Update", "Actualización de Fishingbot", "Mise à jour de Fishingbot", "Fishingbot 更新" },
            new[] { "FISHINGBOT UPDATE", "FISHINGBOT-UPDATE", "ACTUALIZACIÓN DE FISHINGBOT", "MISE À JOUR DE FISHINGBOT", "FISHINGBOT 更新" },
            new[] { "WHAT CHANGED", "WAS SICH GEÄNDERT HAT", "QUÉ CAMBIA", "NOUVEAUTÉS", "更新内容" },
            new[] { "Open the release page on GitHub", "Release-Seite auf GitHub öffnen", "Abrir la página de la versión en GitHub", "Ouvrir la page de la version sur GitHub", "在 GitHub 上打开发布页面" },
            new[] { "INSTALL NOW", "JETZT INSTALLIEREN", "INSTALAR AHORA", "INSTALLER MAINTENANT", "立即安装" },
            new[] { "LATER", "SPÄTER", "MÁS TARDE", "PLUS TARD", "稍后" },
            new[] { "No release notes were published for this version.", "Für diese Version wurden keine Versionshinweise veröffentlicht.", "No se publicaron notas de la versión para esta versión.", "Aucune note de version n'a été publiée pour cette version.", "此版本未发布更新说明。" },
            new[] { "UPDATE AVAILABLE", "UPDATE VERFÜGBAR", "ACTUALIZACIÓN DISPONIBLE", "MISE À JOUR DISPONIBLE", "有可用更新" },
            new[] { "The release has no notes.", "Die Version hat keine Hinweise.", "La versión no tiene notas.", "La version n'a pas de notes.", "此版本没有说明。" },
            new[] { "UPDATE NOW", "JETZT AKTUALISIEREN", "ACTUALIZAR AHORA", "METTRE À JOUR MAINTENANT", "立即更新" },
            new[] { "REMIND ME AGAIN", "MORGEN ERINNERN", "RECORDAR MÁS TARDE", "ME RAPPELER PLUS TARD", "稍后提醒" },
            new[] { "IGNORE THIS VERSION", "DIESE VERSION IGNORIEREN", "IGNORAR ESTA VERSIÓN", "IGNORER CETTE VERSION", "忽略此版本" },
            new[] { "Remind me again", "Später erinnern", "Recordar más tarde", "Me le rappeler", "稍后再提醒我" },
            new[] { "App settings", "App-Einstellungen", "Ajustes de la aplicación", "Réglages de l'application", "应用设置" },
            new[] { "APP SETTINGS", "APP-EINSTELLUNGEN", "AJUSTES DE LA APLICACIÓN", "RÉGLAGES DE L'APPLICATION", "应用设置" },
            new[] { "Desktop options, admin security and Twitch master admin", "Desktop-Optionen, Admin-Sicherheit und Twitch-Master-Admin", "Opciones de escritorio, seguridad de administrador y administrador maestro de Twitch", "Options du bureau, sécurité admin et admin principal Twitch", "桌面选项、管理员安全与 Twitch 主管理员" },
            new[] { "CLOSE", "SCHLIESSEN", "CERRAR", "FERMER", "关闭" },
            new[] { "Admin password", "Admin-Passwort", "Contraseña de administrador", "Mot de passe admin", "管理员密码" },
            new[] { "Used by the security and Twitch actions. Not stored.", "Wird für Sicherheits- und Twitch-Aktionen verwendet. Wird nicht gespeichert.", "Lo usan las acciones de seguridad y de Twitch. No se guarda.", "Utilisé pour les actions de sécurité et Twitch. Non enregistré.", "用于安全与 Twitch 操作。不会保存。" },
            new[] { "SESSION AND PERFORMANCE", "SITZUNG UND LEISTUNG", "SESIÓN Y RENDIMIENTO", "SESSION ET PERFORMANCE", "会话与性能" },
            new[] { "Admin session timeout (minutes, 5–480)", "Admin-Sitzungszeitlimit (Minuten, 5–480)", "Tiempo de espera de la sesión de administrador (minutos, 5–480)", "Délai d'expiration de la session admin (minutes, 5–480)", "管理员会话超时（分钟，5–480）" },
            new[] { "CPU alert above (%, 5–100)", "CPU-Warnung ab (%, 5–100)", "Alerta de CPU por encima de (%, 5–100)", "Alerte CPU au-dessus de (%, 5–100)", "CPU 警报阈值（%，5–100）" },
            new[] { "Server memory limit (MB, 256–8192)", "Speicherlimit des Servers (MB, 256–8192)", "Límite de memoria del servidor (MB, 256–8192)", "Limite de mémoire du serveur (Mo, 256–8192)", "服务器内存上限（MB，256–8192）" },
            new[] { "Network alert above (Mbps, 1–1000)", "Netzwerkwarnung ab (Mbps, 1–1000)", "Alerta de red por encima de (Mbps, 1–1000)", "Alerte réseau au-dessus de (Mbps, 1–1000)", "网络警报阈值（Mbps，1–1000）" },
            new[] { "STARTUP", "START", "INICIO", "DÉMARRAGE", "启动" },
            new[] { "Start Fishingbot Desktop when Windows starts", "Fishingbot Desktop beim Windows-Start öffnen", "Iniciar Fishingbot Desktop al iniciar Windows", "Démarrer Fishingbot Desktop au démarrage de Windows", "Windows 启动时运行 Fishingbot 桌面版" },
            new[] { "Start the Fishingbot server when OBS starts", "Den Fishingbot-Server starten, wenn OBS startet", "Iniciar el servidor de Fishingbot al iniciar OBS", "Démarrer le serveur Fishingbot au lancement d'OBS", "OBS 启动时启动 Fishingbot 服务器" },
            new[] { "Show the startup splash screen", "Startbildschirm anzeigen", "Mostrar la pantalla de inicio", "Afficher l'écran de démarrage", "显示启动画面" },
            new[] { "Keep the live log scrolled", "Live-Protokoll automatisch scrollen", "Mantener el registro en vivo desplazado", "Faire défiler le journal en direct", "实时日志自动滚动" },
            new[] { "Ask before stopping the server", "Vor dem Stoppen des Servers fragen", "Preguntar antes de detener el servidor", "Demander avant d'arrêter le serveur", "停止服务器前询问" },
            new[] { "SAVE SETTINGS", "EINSTELLUNGEN SPEICHERN", "GUARDAR AJUSTES", "ENREGISTRER LES RÉGLAGES", "保存设置" },
            new[] { "CHANGE PASSWORD", "PASSWORT ÄNDERN", "CAMBIAR CONTRASEÑA", "MODIFIER LE MOT DE PASSE", "修改密码" },
            new[] { "SAVE UPDATE SOURCE", "UPDATE-QUELLE SPEICHERN", "GUARDAR ORIGEN DE ACTUALIZACIONES", "ENREGISTRER LA SOURCE DES MISES À JOUR", "保存更新源" },
            new[] { "Check for updates when Fishingbot starts", "Beim Start von Fishingbot nach Updates suchen", "Buscar actualizaciones al iniciar Fishingbot", "Rechercher les mises à jour au démarrage de Fishingbot", "Fishingbot 启动时检查更新" },
            new[] { "SAVE UPDATE SETTINGS", "UPDATE-EINSTELLUNGEN SPEICHERN", "GUARDAR AJUSTES DE ACTUALIZACIÓN", "ENREGISTRER LES RÉGLAGES DE MISE À JOUR", "保存更新设置" },
            new[] { "GENERATE PAIRING CODE", "KOPPLUNGSCODE ERZEUGEN", "GENERAR CÓDIGO DE VINCULACIÓN", "GÉNÉRER UN CODE DE JUMELAGE", "生成配对码" },
            new[] { "UNLINK TWITCH MASTER ADMIN", "TWITCH-MASTER-ADMIN TRENNEN", "DESVINCULAR ADMIN MAESTRO DE TWITCH", "DISSOCIER L'ADMIN PRINCIPAL TWITCH", "解除 Twitch 主管理员绑定" },
            new[] { "GENERAL", "ALLGEMEIN", "GENERAL", "GÉNÉRAL", "常规" },
            new[] { "INTERFACE", "OBERFLÄCHE", "INTERFAZ", "INTERFACE", "界面" },
            new[] { "SECURITY", "SICHERHEIT", "SEGURIDAD", "SÉCURITÉ", "安全" },
            new[] { "UPDATES", "UPDATES", "ACTUALIZACIONES", "MISES À JOUR", "更新" },
            new[] { "TWITCH ADMIN", "TWITCH-ADMIN", "ADMIN DE TWITCH", "ADMIN TWITCH", "Twitch 管理" },
            new[] { "ADMIN PASSWORD", "ADMIN-PASSWORT", "CONTRASEÑA DE ADMINISTRADOR", "MOT DE PASSE ADMIN", "管理员密码" },
            new[] { "Sign-in uses the admin password in the left column. Admin actions need the local server running. Changing the password revokes Twitch Master Admin sessions.", "Die Anmeldung verwendet das Admin-Passwort in der linken Spalte. Admin-Aktionen brauchen den laufenden lokalen Server. Ein Passwortwechsel widerruft Twitch-Master-Admin-Sitzungen.", "El inicio de sesión usa la contraseña de administrador de la columna izquierda. Las acciones de administrador requieren el servidor local en marcha. Cambiar la contraseña revoca las sesiones de administrador maestro de Twitch.", "La connexion utilise le mot de passe admin de la colonne de gauche. Les actions admin nécessitent le serveur local. Changer le mot de passe révoque les sessions admin principal Twitch.", "登录使用左侧的管理员密码。管理员操作需要本地服务器运行。修改密码会撤销 Twitch 主管理员会话。" },
            new[] { "New admin password (at least 12 characters)", "Neues Admin-Passwort (mindestens 12 Zeichen)", "Nueva contraseña de administrador (al menos 12 caracteres)", "Nouveau mot de passe admin (au moins 12 caractères)", "新管理员密码（至少 12 个字符）" },
            new[] { "UPDATE SOURCE", "UPDATE-QUELLE", "ORIGEN DE ACTUALIZACIONES", "SOURCE DES MISES À JOUR", "更新源" },
            new[] { "GitHub repository that Check updates reads from. Write it as owner/repository, without https:// or .git.", "GitHub-Repository, aus dem die Update-Prüfung liest. Schreibe es als Besitzer/Repository, ohne https:// oder .git.", "Repositorio de GitHub del que lee la comprobación. Escríbelo como propietario/repositorio, sin https:// ni .git.", "Dépôt GitHub lu par la vérification. Écrivez-le sous la forme propriétaire/dépôt, sans https:// ni .git.", "检查更新所读取的 GitHub 仓库。格式为 所有者/仓库，不要包含 https:// 或 .git。" },
            new[] { "Repository", "Repository", "Repositorio", "Dépôt", "仓库" },
            new[] { "AUTOMATIC UPDATES", "AUTOMATISCHE UPDATES", "ACTUALIZACIONES AUTOMÁTICAS", "MISES À JOUR AUTOMATIQUES", "自动更新" },
            new[] { "Looks for a newer verified release when Fishingbot starts. A pop-up then offers Update now, Remind me again or Ignore this version.", "Sucht beim Start von Fishingbot nach einer neueren verifizierten Version. Ein Hinweisfenster bietet dann Jetzt aktualisieren, Morgen erinnern oder Diese Version ignorieren an.", "Busca una versión verificada más reciente al iniciar Fishingbot. Después aparece una ventana con Actualizar ahora, Recordar más tarde o Ignorar esta versión.", "Recherche une version vérifiée plus récente au démarrage de Fishingbot. Une fenêtre propose ensuite Mettre à jour, Me rappeler plus tard ou Ignorer cette version.", "Fishingbot 启动时查找较新的已验证版本。随后会弹窗提供“立即更新”“稍后提醒”或“忽略此版本”。" },
            new[] { "Creates a one-time code for linking the Twitch Extension. The code expires after two minutes. Uses the admin password in the left column.", "Erstellt einen einmaligen Code zum Verknüpfen der Twitch-Erweiterung. Der Code läuft nach zwei Minuten ab. Verwendet das Admin-Passwort in der linken Spalte.", "Crea un código de un solo uso para vincular la extensión de Twitch. El código caduca en dos minutos. Usa la contraseña de administrador de la columna izquierda.", "Crée un code à usage unique pour lier l'extension Twitch. Le code expire au bout de deux minutes. Utilise le mot de passe admin de la colonne de gauche.", "生成一次性代码，用于关联 Twitch 扩展。代码两分钟后过期。使用左侧的管理员密码。" },
            new[] { "UNLINK", "TRENNEN", "DESVINCULAR", "DISSOCIER", "解除绑定" },
            new[] { "Revokes the linked Twitch identity and every Extension Master Admin session.", "Widerruft die verknüpfte Twitch-Identität und jede Sitzung des Erweiterungs-Master-Admins.", "Revoca la identidad de Twitch vinculada y todas las sesiones de administrador maestro de la extensión.", "Révoque l'identité Twitch liée et toutes les sessions admin principal de l'extension.", "撤销已关联的 Twitch 身份以及所有扩展主管理员会话。" },
            new[] { "No active code. Generate one when you are ready to link Twitch.", "Kein aktiver Code. Erstelle einen, wenn du Twitch verknüpfen möchtest.", "No hay código activo. Genera uno cuando quieras vincular Twitch.", "Aucun code actif. Générez-en un lorsque vous êtes prêt à lier Twitch.", "没有有效代码。准备好关联 Twitch 时再生成。" },
            new[] { "Enter the code in Twitch: Extension, My Account, Master Admin.", "Gib den Code in Twitch ein: Erweiterung, Mein Konto, Master-Admin.", "Introduce el código en Twitch: Extensión, Mi cuenta, Administrador maestro.", "Saisissez le code dans Twitch : Extension, Mon compte, Admin principal.", "在 Twitch 中输入代码：扩展、我的账号、主管理员。" },
            new[] { "Unlink Twitch Master Admin", "Twitch-Master-Admin trennen", "Desvincular administrador maestro de Twitch", "Dissocier l'admin principal Twitch", "解除 Twitch 主管理员绑定" },
            new[] { "KEEP LINKED", "VERKNÜPFT LASSEN", "MANTENER VINCULADO", "GARDER LIÉ", "保持关联" },
            new[] { "Unlink the Twitch identity and revoke every Extension Master Admin session?", "Die Twitch-Identität trennen und jede Sitzung des Erweiterungs-Master-Admins widerrufen?", "¿Desvincular la identidad de Twitch y revocar todas las sesiones de administrador maestro de la extensión?", "Dissocier l'identité Twitch et révoquer toutes les sessions admin principal de l'extension ?", "解除 Twitch 身份绑定并撤销所有扩展主管理员会话？" },
            new[] { "Working...", "Arbeite...", "Trabajando...", "Traitement...", "处理中..." },
            new[] { "update available", "Update verfügbar", "actualización disponible", "mise à jour disponible", "有可用更新" },
            new[] { "Choose a language", "Sprache wählen", "Elige un idioma", "Choisir la langue", "选择语言" },
            new[] { "Used for setup and Fishingbot. You can change it later in the Control Centre.", "Wird für die Einrichtung und Fishingbot verwendet. Du kannst sie später im Kontrollzentrum ändern.", "Se usa para la instalación y Fishingbot. Puedes cambiarlo más tarde en el centro de control.", "Utilisée pour l'installation et Fishingbot. Vous pourrez la changer plus tard dans le centre de contrôle.", "用于安装程序和 Fishingbot。之后可在控制中心更改。" },
            new[] { "LANGUAGE", "SPRACHE", "IDIOMA", "LANGUE", "语言" },
            new[] { "NEXT", "WEITER", "SIGUIENTE", "SUIVANT", "下一步" },
            new[] { "Control Centre", "Kontrollzentrum", "Centro de control", "Centre de contrôle", "控制中心" },
            new[] { "Next", "Weiter", "Siguiente", "Suivant", "下一步" },
            new[] { "Start Fishingbot", "Fishingbot starten", "Iniciar Fishingbot", "Démarrer Fishingbot", "启动 Fishingbot" },
            new[] { "Fishingbot Setup", "Fishingbot-Einrichtung", "Instalación de Fishingbot", "Installation de Fishingbot", "Fishingbot 安装程序" },
            new[] { "Needs about ", "Benötigt etwa ", "Necesita unos ", "Nécessite environ ", "需要约 " },
            new[] { " MB  \u00B7  free on ", " MB  ·  frei auf ", " MB  ·  libre en ", " Mo  ·  libre sur ", " MB  ·  可用于 " },
            new[] { "Windows user install  \u00B7  no admin rights  \u00B7  about ", "Windows-Benutzerinstallation  ·  keine Admin-Rechte  ·  etwa ", "Instalación para el usuario de Windows  ·  sin derechos de administrador  ·  unos ", "Installation utilisateur Windows  ·  sans droits admin  ·  environ ", "Windows 用户安装  ·  无需管理员权限  ·  约 " },
            new[] { "Pre-update backup  ", "Sicherung vor dem Update  ", "Copia de seguridad previa a la actualización  ", "Sauvegarde avant mise à jour  ", "更新前备份  " },
            new[] { "There is not enough free space on ", "Nicht genug freier Speicherplatz auf ", "No hay suficiente espacio libre en ", "Espace libre insuffisant sur ", "磁盘空间不足：" },
            new[] { "Port ", "Port ", "El puerto ", "Le port ", "端口 " },
            new[] { " is already in use. If Fishingbot is already running, that is expected. Continue anyway?", " ist bereits belegt. Wenn Fishingbot bereits läuft, ist das normal. Trotzdem fortfahren?", " ya está en uso. Si Fishingbot ya está en marcha, es lo esperado. ¿Continuar de todos modos?", " est déjà utilisé. Si Fishingbot est déjà lancé, c'est normal. Continuer quand même ?", " 已被占用。如果 Fishingbot 已在运行，这是正常的。仍要继续吗？" },
            new[] { "Choose another port, or close the program that uses port ", "Wähle einen anderen Port oder schließe das Programm, das Port ", "Elige otro puerto o cierra el programa que usa el puerto ", "Choisissez un autre port ou fermez le programme qui utilise le port ", "请选择其他端口，或关闭占用端口 " },
            new[] { "Program files, shortcuts and the Windows uninstall entry.", "Programmdateien, Verknüpfungen und der Windows-Deinstallationseintrag.", "Archivos del programa, accesos directos y la entrada de desinstalación de Windows.", "Fichiers du programme, raccourcis et entrée de désinstallation Windows.", "程序文件、快捷方式和 Windows 卸载项。" },
            new[] { "Setup could not finish: ", "Die Einrichtung konnte nicht abgeschlossen werden: ", "La instalación no pudo terminar: ", "L'installation n'a pas pu se terminer : ", "安装无法完成：" },
            new[] { "   Details: ", "   Details: ", "   Detalles: ", "   Détails : ", "   详情：" },
            new[] { "Updating program files...", "Programmdateien werden aktualisiert...", "Actualizando archivos del programa...", "Mise à jour des fichiers du programme...", "正在更新程序文件..." },
            new[] { "BACK", "ZURÜCK", "ATRÁS", "RETOUR", "上一步" },
            new[] { "SETUP", "EINRICHTUNG", "INSTALACIÓN", "INSTALLATION", "安装" },
            new[] { "Set up Fishingbot", "Fishingbot einrichten", "Configurar Fishingbot", "Installer Fishingbot", "设置 Fishingbot" },
            new[] { "Choose a folder", "Ordner wählen", "Elegir una carpeta", "Choisir un dossier", "选择文件夹" },
            new[] { "Connect Twitch", "Twitch verbinden", "Conectar Twitch", "Connecter Twitch", "连接 Twitch" },
            new[] { "Shortcuts and review", "Verknüpfungen und Überprüfung", "Accesos directos y revisión", "Raccourcis et vérification", "快捷方式与确认" },
            new[] { "Installing", "Installation läuft", "Instalando", "Installation en cours", "正在安装" },
            new[] { "Installed", "Installiert", "Instalado", "Installé", "已安装" },
            new[] { "About five minutes. No admin rights needed.", "Etwa fünf Minuten. Keine Administratorrechte nötig.", "Unos cinco minutos. No necesitas derechos de administrador.", "Environ cinq minutes. Aucun droit administrateur requis.", "约五分钟。无需管理员权限。" },
            new[] { "Program files go in this folder.", "Die Programmdateien werden in diesem Ordner abgelegt.", "Los archivos del programa van en esta carpeta.", "Les fichiers du programme sont placés dans ce dossier.", "程序文件将放在此文件夹中。" },
            new[] { "The Twitch sign-in is built in. You approve it once.", "Die Twitch-Anmeldung ist integriert. Du bestätigst sie einmal.", "El inicio de sesión de Twitch está incluido. Lo apruebas una vez.", "La connexion Twitch est intégrée. Vous l'approuvez une seule fois.", "Twitch 登录已内置。只需批准一次。" },
            new[] { "Choose what setup adds, then install.", "Wähle aus, was die Einrichtung hinzufügt, und installiere dann.", "Elige lo que añade la instalación y luego instala.", "Choisissez ce que l'installation ajoute, puis installez.", "选择安装程序要添加的内容，然后安装。" },
            new[] { "Keep this window open. This takes less than a minute.", "Lass dieses Fenster offen. Das dauert weniger als eine Minute.", "Deja esta ventana abierta. Tarda menos de un minuto.", "Gardez cette fenêtre ouverte. Cela prend moins d'une minute.", "请保持此窗口打开。通常不到一分钟。" },
            new[] { "Fishingbot is ready on this computer.", "Fishingbot ist auf diesem Computer einsatzbereit.", "Fishingbot está listo en este equipo.", "Fishingbot est prêt sur cet ordinateur.", "Fishingbot 已在此电脑上就绪。" },
            new[] { "Fishingbot runs on this PC. The game, database and chat bot stay local. Only public channel updates pass through a secure relay to the Twitch Extension.", "Fishingbot läuft auf diesem PC. Spiel, Datenbank und Chat-Bot bleiben lokal. Nur öffentliche Kanal-Updates laufen über ein sicheres Relay zur Twitch-Erweiterung.", "Fishingbot funciona en este PC. El juego, la base de datos y el bot de chat se quedan en local. Solo las actualizaciones públicas del canal pasan por un relay seguro hasta la extensión de Twitch.", "Fishingbot fonctionne sur ce PC. Le jeu, la base de données et le bot de chat restent en local. Seules les mises à jour publiques de la chaîne passent par un relais sécurisé vers l'extension Twitch.", "Fishingbot 在此电脑上运行。游戏、数据库和聊天机器人都保留在本地。只有公开的频道更新会通过安全中继发送到 Twitch 扩展。" },
            new[] { "Upgrading? Setup finds your existing folder and updates it in place. Settings, the database and the Twitch login are backed up before anything changes.", "Aktualisierst du? Die Einrichtung findet deinen vorhandenen Ordner und aktualisiert ihn an Ort und Stelle. Einstellungen, Datenbank und Twitch-Anmeldung werden vor jeder Änderung gesichert.", "¿Actualizas? La instalación encuentra tu carpeta actual y la actualiza en su sitio. Los ajustes, la base de datos y el inicio de sesión de Twitch se copian antes de cualquier cambio.", "Mise à niveau ? L'installation retrouve votre dossier existant et le met à jour sur place. Les réglages, la base de données et la connexion Twitch sont sauvegardés avant toute modification.", "要升级吗？安装程序会找到现有文件夹并原地更新。设置、数据库和 Twitch 登录信息会在任何更改前备份。" },
            new[] { "Three steps", "Drei Schritte", "Tres pasos", "Trois étapes", "三个步骤" },
            new[] { "Choose the install folder", "Installationsordner wählen", "Elige la carpeta de instalación", "Choisissez le dossier d'installation", "选择安装文件夹" },
            new[] { "Connect Twitch with a one-time code", "Twitch mit einem einmaligen Code verbinden", "Conecta Twitch con un código de un solo uso", "Connectez Twitch avec un code à usage unique", "使用一次性代码连接 Twitch" },
            new[] { "Activate the Extension on your channel", "Erweiterung in deinem Kanal aktivieren", "Activa la extensión en tu canal", "Activez l'extension sur votre chaîne", "在你的频道上启用扩展" },
            new[] { "Install folder", "Installationsordner", "Carpeta de instalación", "Dossier d'installation", "安装文件夹" },
            new[] { "BROWSE", "DURCHSUCHEN", "EXPLORAR", "PARCOURIR", "浏览" },
            new[] { "Choose the folder for Fishingbot", "Ordner für Fishingbot wählen", "Elige la carpeta para Fishingbot", "Choisissez le dossier de Fishingbot", "为 Fishingbot 选择文件夹" },
            new[] { "Enter a valid folder path.", "Gib einen gültigen Ordnerpfad ein.", "Introduce una ruta de carpeta válida.", "Saisissez un chemin de dossier valide.", "请输入有效的文件夹路径。" },
            new[] { "This folder contains a newer Fishingbot version. To prevent an accidental downgrade, use its installer or choose another folder.", "Dieser Ordner enthält eine neuere Fishingbot-Version. Um ein versehentliches Downgrade zu verhindern, nutze deren Installationsprogramm oder wähle einen anderen Ordner.", "Esta carpeta contiene una versión más reciente de Fishingbot. Para evitar una degradación accidental, usa su instalador o elige otra carpeta.", "Ce dossier contient une version plus récente de Fishingbot. Pour éviter une rétrogradation accidentelle, utilisez son programme d'installation ou choisissez un autre dossier.", "此文件夹包含更新版本的 Fishingbot。为防止意外降级，请使用其安装程序或选择其他文件夹。" },
            new[] { "This folder is not a recognized Fishingbot installation and is not empty. Choose an empty folder so existing files cannot be overwritten.", "Dieser Ordner ist keine erkannte Fishingbot-Installation und nicht leer. Wähle einen leeren Ordner, damit vorhandene Dateien nicht überschrieben werden.", "Esta carpeta no es una instalación de Fishingbot reconocida y no está vacía. Elige una carpeta vacía para que no se sobrescriban archivos existentes.", "Ce dossier n'est pas une installation Fishingbot reconnue et n'est pas vide. Choisissez un dossier vide pour que les fichiers existants ne soient pas écrasés.", "此文件夹不是可识别的 Fishingbot 安装，且并非空文件夹。请选择空文件夹，以免覆盖现有文件。" },
            new[] { "Twitch connection", "Twitch-Verbindung", "Conexión con Twitch", "Connexion Twitch", "Twitch 连接" },
            new[] { "This build includes Fishingbot's public Twitch application ID. After setup, press Connect account in the Control Centre and approve the one-time code Twitch shows you. No developer console or Extension secret is needed.", "Diese Version enthält Fishingbots öffentliche Twitch-Anwendungs-ID. Drücke nach der Einrichtung im Kontrollzentrum auf Konto verbinden und bestätige den einmaligen Code, den Twitch anzeigt. Es werden keine Entwicklerkonsole und kein Erweiterungs-Geheimnis benötigt.", "Esta versión incluye el ID público de aplicación de Twitch de Fishingbot. Tras la instalación, pulsa Conectar cuenta en el centro de control y aprueba el código de un solo uso que muestra Twitch. No hace falta la consola de desarrollador ni el secreto de la extensión.", "Cette version inclut l'ID public de l'application Twitch de Fishingbot. Après l'installation, cliquez sur Connecter le compte dans le centre de contrôle et approuvez le code à usage unique affiché par Twitch. Aucune console développeur ni secret d'extension n'est nécessaire.", "此版本包含 Fishingbot 的公开 Twitch 应用 ID。安装后，在控制中心点击“连接账号”，并批准 Twitch 显示的一次性代码。无需开发者控制台或扩展密钥。" },
            new[] { "Local server port", "Lokaler Server-Port", "Puerto del servidor local", "Port du serveur local", "本地服务器端口" },
            new[] { "The server stays on this computer. Its connection to the relay is outbound HTTPS, so no router port needs to be opened.", "Der Server bleibt auf diesem Computer. Seine Verbindung zum Relay ist ausgehend (HTTPS), daher muss kein Router-Port geöffnet werden.", "El servidor se queda en este equipo. Su conexión con el relay es HTTPS saliente, así que no hace falta abrir ningún puerto del router.", "Le serveur reste sur cet ordinateur. Sa connexion au relais est en HTTPS sortant : aucun port du routeur n'a besoin d'être ouvert.", "服务器只在此电脑上运行。它与中继的连接是出站 HTTPS，因此无需在路由器上开放端口。" },
            new[] { "PORT", "PORT", "PUERTO", "PORT", "端口" },
            new[] { "Enter a port between 1024 and 65535. The default is 3000.", "Gib einen Port zwischen 1024 und 65535 ein. Standard ist 3000.", "Introduce un puerto entre 1024 y 65535. El predeterminado es 3000.", "Saisissez un port entre 1024 et 65535. La valeur par défaut est 3000.", "请输入 1024 到 65535 之间的端口。默认为 3000。" },
            new[] { "CONTINUE", "WEITER", "CONTINUAR", "CONTINUER", "继续" },
            new[] { "CHOOSE PORT", "PORT WÄHLEN", "ELEGIR PUERTO", "CHOISIR LE PORT", "选择端口" },
            new[] { "Shortcuts", "Verknüpfungen", "Accesos directos", "Raccourcis", "快捷方式" },
            new[] { "Add Fishingbot to the Start Menu", "Fishingbot zum Startmenü hinzufügen", "Añadir Fishingbot al menú Inicio", "Ajouter Fishingbot au menu Démarrer", "添加 Fishingbot 到开始菜单" },
            new[] { "Create a desktop shortcut", "Desktop-Verknüpfung erstellen", "Crear un acceso directo en el escritorio", "Créer un raccourci sur le bureau", "创建桌面快捷方式" },
            new[] { "Review", "Überprüfung", "Revisión", "Vérification", "确认" },
            new[] { "Folder", "Ordner", "Carpeta", "Dossier", "文件夹" },
            new[] { "Port", "Port", "Puerto", "Port", "端口" },
            new[] { "Twitch client", "Twitch-Client", "Cliente de Twitch", "Client Twitch", "Twitch 客户端" },
            new[] { "Network", "Netzwerk", "Red", "Réseau", "网络" },
            new[] { "Local only. Relay uses outbound HTTPS.", "Nur lokal. Das Relay nutzt ausgehendes HTTPS.", "Solo local. El relay usa HTTPS saliente.", "Local uniquement. Le relais utilise le HTTPS sortant.", "仅本地。中继使用出站 HTTPS。" },
            new[] { "Starting...", "Wird gestartet...", "Iniciando...", "Démarrage...", "正在启动..." },
            new[] { "Installed. Your data is kept.", "Installiert. Deine Daten bleiben erhalten.", "Instalado. Tus datos se conservan.", "Installé. Vos données sont conservées.", "已安装。你的数据已保留。" },
            new[] { "Press Connect account in the Control Centre", "Im Kontrollzentrum auf Konto verbinden drücken", "Pulsa Conectar cuenta en el centro de control", "Cliquez sur Connecter le compte dans le centre de contrôle", "在控制中心点击“连接账号”" },
            new[] { "Approve Fishingbot with the one-time Twitch code", "Fishingbot mit dem einmaligen Twitch-Code bestätigen", "Aprueba Fishingbot con el código de un solo uso de Twitch", "Approuvez Fishingbot avec le code Twitch à usage unique", "使用一次性 Twitch 代码批准 Fishingbot" },
            new[] { "Type !fish in your chat", "Tippe !fish in deinen Chat", "Escribe !fish en tu chat", "Tapez !fish dans votre chat", "在聊天中输入 !fish" },
            new[] { "Start Fishingbot when I press Finish", "Fishingbot starten, wenn ich auf Fertigstellen drücke", "Iniciar Fishingbot al pulsar Finalizar", "Démarrer Fishingbot quand j'appuie sur Terminer", "点击“完成”时启动 Fishingbot" },
            new[] { "DONE", "FERTIG", "LISTO", "TERMINÉ", "完成" },
            new[] { "STEP", "SCHRITT", "PASO", "ÉTAPE", "步骤" },
            new[] { "OF", "VON", "DE", "SUR", "/" },
            new[] { "INSTALLING", "INSTALLIERE", "INSTALANDO", "INSTALLATION", "安装中" },
            new[] { "GET STARTED", "LOSLEGEN", "EMPEZAR", "COMMENCER", "开始" },
            new[] { "INSTALL", "INSTALLIEREN", "INSTALAR", "INSTALLER", "安装" },
            new[] { "FINISH", "FERTIG STELLEN", "FINALIZAR", "TERMINER", "完成" },
            new[] { "Cancel setup? Nothing has been installed yet.", "Einrichtung abbrechen? Es wurde noch nichts installiert.", "¿Cancelar la instalación? Todavía no se ha instalado nada.", "Annuler l'installation ? Rien n'a encore été installé.", "取消安装？尚未安装任何内容。" },
            new[] { "CANCEL SETUP", "EINRICHTUNG ABBRECHEN", "CANCELAR INSTALACIÓN", "ANNULER L'INSTALLATION", "取消安装" },
            new[] { "KEEP GOING", "WEITERMACHEN", "SEGUIR", "CONTINUER", "继续安装" },
            new[] { "Setup could not finish.", "Die Einrichtung konnte nicht abgeschlossen werden.", "La instalación no pudo terminar.", "L'installation n'a pas pu se terminer.", "安装无法完成。" },
            new[] { "What gets removed", "Was entfernt wird", "Qué se elimina", "Ce qui sera supprimé", "将删除的内容" },
            new[] { "Also delete my data and recovery backups", "Auch meine Daten und Wiederherstellungs-Sicherungen löschen", "Eliminar también mis datos y las copias de recuperación", "Supprimer aussi mes données et sauvegardes de récupération", "同时删除我的数据和恢复备份" },
            new[] { "Keep your data if you may reinstall later. Deleting also removes the pre-update recovery archives and the stored Twitch bot token.", "Behalte deine Daten, falls du später neu installieren möchtest. Löschen entfernt außerdem die Wiederherstellungsarchive vor Updates und das gespeicherte Twitch-Bot-Token.", "Conserva tus datos si quizá reinstales más adelante. Al eliminar también se borran los archivos de recuperación previos a la actualización y el token guardado del bot de Twitch.", "Conservez vos données si vous pourriez réinstaller plus tard. La suppression efface aussi les archives de récupération d'avant mise à jour et le jeton du bot Twitch enregistré.", "如果以后可能重新安装，请保留数据。删除还会移除更新前的恢复存档和已保存的 Twitch 机器人令牌。" },
            new[] { "Removing", "Wird entfernt", "Eliminando", "Suppression", "正在删除" },
            new[] { "Removed", "Entfernt", "Eliminado", "Supprimé", "已删除" },
            new[] { "Removes the program from this computer.", "Entfernt das Programm von diesem Computer.", "Elimina el programa de este equipo.", "Supprime le programme de cet ordinateur.", "从此电脑中删除程序。" },
            new[] { "Please wait.", "Bitte warten.", "Espera, por favor.", "Veuillez patienter.", "请稍候。" },
            new[] { "REMOVING", "WIRD ENTFERNT", "ELIMINANDO", "SUPPRESSION", "正在删除" },
            new[] { "UNINSTALL", "DEINSTALLIEREN", "DESINSTALAR", "DÉSINSTALLER", "卸载" },
            new[] { "Uninstall Fishingbot", "Fishingbot deinstallieren", "Desinstalar Fishingbot", "Désinstaller Fishingbot", "卸载 Fishingbot" },
            new[] { "Fishingbot was removed.", "Fishingbot wurde entfernt.", "Fishingbot se ha eliminado.", "Fishingbot a été supprimé.", "Fishingbot 已删除。" },
            new[] { "Stopping Fishingbot safely...", "Fishingbot wird sicher gestoppt...", "Deteniendo Fishingbot de forma segura...", "Arrêt sécurisé de Fishingbot...", "正在安全停止 Fishingbot..." },
            new[] { "Creating a private pre-update backup...", "Private Sicherung vor dem Update wird erstellt...", "Creando una copia privada previa a la actualización...", "Création d'une sauvegarde privée avant mise à jour...", "正在创建更新前的私有备份..." },
            new[] { "Preparing a fresh installation...", "Neue Installation wird vorbereitet...", "Preparando una instalación nueva...", "Préparation d'une nouvelle installation...", "正在准备全新安装..." },
            new[] { "Updating and repairing program files...", "Programmdateien werden aktualisiert und repariert...", "Actualizando y reparando los archivos del programa...", "Mise à jour et réparation des fichiers du programme...", "正在更新并修复程序文件..." },
            new[] { "Installing program files...", "Programmdateien werden installiert...", "Instalando los archivos del programa...", "Installation des fichiers du programme...", "正在安装程序文件..." },
            new[] { "Installing the uninstaller...", "Deinstallationsprogramm wird installiert...", "Instalando el desinstalador...", "Installation du désinstallateur...", "正在安装卸载程序..." },
            new[] { "Removing obsolete files from previous Fishingbot releases...", "Veraltete Dateien aus früheren Fishingbot-Versionen werden entfernt...", "Eliminando archivos obsoletos de versiones anteriores de Fishingbot...", "Suppression des fichiers obsolètes des versions précédentes de Fishingbot...", "正在删除旧版 Fishingbot 的过时文件..." },
            new[] { "Preserving your settings and database...", "Deine Einstellungen und Datenbank werden bewahrt...", "Conservando tus ajustes y tu base de datos...", "Conservation de vos réglages et de votre base de données...", "正在保留你的设置和数据库..." },
            new[] { "Writing the install manifest...", "Installationsmanifest wird geschrieben...", "Escribiendo el manifiesto de instalación...", "Écriture du manifeste d'installation...", "正在写入安装清单..." },
            new[] { "Refreshing shortcuts...", "Verknüpfungen werden aktualisiert...", "Actualizando accesos directos...", "Mise à jour des raccourcis...", "正在刷新快捷方式..." },
            new[] { "Registering the installed version...", "Installierte Version wird registriert...", "Registrando la versión instalada...", "Enregistrement de la version installée...", "正在注册已安装的版本..." },
            new[] { "Update complete. Your data is preserved.", "Update abgeschlossen. Deine Daten bleiben erhalten.", "Actualización completada. Tus datos se conservan.", "Mise à jour terminée. Vos données sont conservées.", "更新完成。你的数据已保留。" },
            new[] { "Installation complete.", "Installation abgeschlossen.", "Instalación completada.", "Installation terminée.", "安装完成。" },
            new[] { "Stopping Fishingbot...", "Fishingbot wird gestoppt...", "Deteniendo Fishingbot...", "Arrêt de Fishingbot...", "正在停止 Fishingbot..." },
            new[] { "Removing shortcuts...", "Verknüpfungen werden entfernt...", "Eliminando accesos directos...", "Suppression des raccourcis...", "正在删除快捷方式..." },
            new[] { "Done.", "Fertig.", "Listo.", "Terminé.", "完成。" },
            new[] { "Removing program files...", "Programmdateien werden entfernt...", "Eliminando los archivos del programa...", "Suppression des fichiers du programme...", "正在删除程序文件..." },
            new[] { "Checking remaining files...", "Verbleibende Dateien werden geprüft...", "Comprobando los archivos restantes...", "Vérification des fichiers restants...", "正在检查剩余文件..." },
            new[] { "Removing Windows registration...", "Windows-Registrierung wird entfernt...", "Eliminando el registro de Windows...", "Suppression de l'enregistrement Windows...", "正在删除 Windows 注册信息..." },
            new[] { "Uninstall complete.", "Deinstallation abgeschlossen.", "Desinstalación completada.", "Désinstallation terminée.", "卸载完成。" },
            new[] { "{0} MIN AGO", "VOR {0} MIN", "HACE {0} MIN", "IL Y A {0} MIN", "{0} 分钟前" },
            new[] { "{0} MIN", "{0} MIN", "{0} MIN", "{0} MIN", "{0} 分钟" },
            new[] { "ALL", "ALLE", "TODO", "TOUT", "全部" },
            new[] { "RUNTIME  ·  LAST {0} MINUTES", "LAUFZEIT  ·  LETZTE {0} MINUTEN", "TIEMPO DE EJECUCIÓN  ·  ÚLTIMOS {0} MINUTOS", "DURÉE  ·  {0} DERNIÈRES MINUTES", "运行时间  ·  最近{0}分钟" },
            new[] { "NO WARNINGS OR ERRORS", "KEINE WARNUNGEN ODER FEHLER", "SIN AVISOS NI ERRORES", "AUCUN AVERTISSEMENT NI ERREUR", "没有警告或错误" },
            new[] { "NO WARNINGS", "KEINE WARNUNGEN", "SIN AVISOS", "AUCUN AVERTISSEMENT", "没有警告" },
            new[] { "NO ERRORS", "KEINE FEHLER", "SIN ERRORES", "AUCUNE ERREUR", "没有错误" },
            new[] { "SERVER STOPPED  ·  NO DATA", "SERVER GESTOPPT  ·  KEINE DATEN", "SERVIDOR DETENIDO  ·  SIN DATOS", "SERVEUR ARRÊTÉ  ·  AUCUNE DONNÉE", "服务器已停止  ·  无数据" },
            new[] { "Server output appears here once the server starts.", "Die Serverausgabe erscheint hier, sobald der Server gestartet ist.", "La salida del servidor aparece aquí cuando el servidor se inicia.", "La sortie du serveur apparaît ici une fois le serveur démarré.", "服务器启动后，输出会显示在这里。" },
        };

        private static readonly Dictionary<string, string[]> Table = new Dictionary<string, string[]>();
        private static readonly Dictionary<string, string> EnglishFor = new Dictionary<string, string>();
        private static int _index;

        static Loc()
        {
            foreach (string[] row in Rows)
            {
                Table[row[0]] = row;
                foreach (string text in row)
                {
                    if (!EnglishFor.ContainsKey(text)) EnglishFor[text] = row[0];
                }
            }
        }

        public static event EventHandler LanguageChanged;

        public static string Language { get { return Codes[_index]; } }

        public static void SetLanguage(string code)
        {
            int index = Array.IndexOf(Codes, (code ?? "").Trim().ToLowerInvariant());
            if (index < 0) index = 0;
            if (index == _index) return;
            _index = index;
            EventHandler handler = LanguageChanged;
            if (handler != null) handler(null, EventArgs.Empty);
        }

        // The text for one English string in the current language. Text that is not in the table is returned as it is.
        public static string T(string text)
        {
            if (string.IsNullOrEmpty(text)) return text;
            string key = text;
            if (!Table.ContainsKey(key))
            {
                if (!EnglishFor.TryGetValue(text, out key)) return text;
            }
            string translated = Table[key][_index];
            return string.IsNullOrEmpty(translated) ? key : translated;
        }

        // Translates each line of a multi-line label separately (lines are joined with CR LF).
        public static string Lines(string text)
        {
            if (string.IsNullOrEmpty(text)) return text;
            string[] parts = text.Split(new[] { "\r\n" }, StringSplitOptions.None);
            for (int i = 0; i < parts.Length; i++) parts[i] = T(parts[i]);
            return string.Join("\r\n", parts);
        }

        // Translates the text of a control and of everything inside it.
        public static void Apply(Control root)
        {
            if (root == null) return;
            string current = root.Text;
            if (!string.IsNullOrEmpty(current))
            {
                string next = Lines(current);
                if (next != current) root.Text = next;
            }
            foreach (Control child in root.Controls) Apply(child);
        }
    }
}
