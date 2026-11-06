/* Ma Cave - synchronisation Google Drive
   Aucun secret client n'est utilisé dans le navigateur. L'ID client OAuth est public.
   Le fichier de sauvegarde est créé par Ma Cave et accessible via le périmètre drive.file. */
(() => {
  "use strict";
  const CLIENT_ID = "867803383648-mqk0n7l79cttesi4p5ousvvh6lvno36d.apps.googleusercontent.com";
  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const FILE_NAME = "Ma Cave - sauvegarde.json";
  const CONNECTED_KEY = "ma-cave-drive-connected-v1";
  const FILE_ID_KEY = "ma-cave-drive-file-id-v1";
  const INITIALIZED_KEY = "ma-cave-drive-initialized-v1";
  let tokenClient = null;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let pendingToken = null;
  let syncTimer = null;
  let syncing = false;
  let lastStateFingerprint = "";

  const el = id => document.getElementById(id);
  const status = (message, kind="") => {
    const node = el("driveStatus");
    if (node) {
      node.textContent = message;
      node.className = "drive-status" + (kind ? " " + kind : "");
    }
  };
  const setConnectedUI = connected => {
    const connect = el("connectDrive");
    const sync = el("syncDrive");
    if (connect) {
      connect.textContent = connected ? "Reconnecter Google Drive" : "Connecter Google Drive";
    }
    if (sync) sync.hidden = !connected;
  };
  const getState = () => {
    try { return JSON.parse(localStorage.getItem("ma-cave-v1") || '{"wines":[],"moves":[]}'); }
    catch (_) { return {wines:[], moves:[]}; }
  };
  const fingerprint = data => {
    // Déterministe pour éviter des envois inutiles ; les photos sont incluses.
    return JSON.stringify(data);
  };
  const hasLocalData = data => Array.isArray(data.wines) && data.wines.length > 0;

  function ensureTokenClient() {
    if (tokenClient) return true;
    if (!window.google?.accounts?.oauth2) return false;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: response => {
        if (response && response.access_token) {
          accessToken = response.access_token;
          tokenExpiresAt = Date.now() + ((Number(response.expires_in) || 3600) * 1000);
          localStorage.setItem(CONNECTED_KEY, "1");
          setConnectedUI(true);
          status("Google Drive est connecté. Synchronisation en cours…", "ok");
          if (pendingToken) { pendingToken.resolve(accessToken); pendingToken = null; }
          firstSync().catch(err => {
            console.error(err);
            status("Connexion établie, mais la synchronisation a échoué : " + (err.message || "erreur inconnue"), "error");
          });
        } else {
          const msg = response?.error_description || response?.error || "Autorisation Google non accordée.";
          if (pendingToken) { pendingToken.reject(new Error(msg)); pendingToken = null; }
          status("Connexion non établie : " + msg, "error");
          setConnectedUI(false);
        }
      },
      error_callback: error => {
        const msg = error?.message || error?.type || "La fenêtre de connexion Google n'a pas pu être ouverte.";
        if (pendingToken) { pendingToken.reject(new Error(msg)); pendingToken = null; }
        status(msg, "error");
      }
    });
    return true;
  }

  function requestToken(promptValue) {
    if (!ensureTokenClient()) return Promise.reject(new Error("Le service de connexion Google ne s'est pas chargé. Vérifiez votre connexion Internet puis rechargez Ma Cave."));
    if (pendingToken) return pendingToken.promise;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve=res; reject=rej; });
    pendingToken = {promise, resolve, reject};
    try { tokenClient.requestAccessToken({prompt: promptValue}); }
    catch (e) { pendingToken=null; reject(e); }
    return promise;
  }

  async function authorizedFetch(url, options={}) {
    if (!accessToken || Date.now() > tokenExpiresAt - 60000) {
      // GIS peut renouveler silencieusement après consentement ; sinon une reconnexion sera demandée.
      await requestToken("");
    }
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", "Bearer " + accessToken);
    const response = await fetch(url, {...options, headers});
    if (response.status === 401) {
      accessToken = null; tokenExpiresAt = 0;
      await requestToken("");
      const retryHeaders = new Headers(options.headers || {});
      retryHeaders.set("Authorization", "Bearer " + accessToken);
      return fetch(url, {...options, headers: retryHeaders});
    }
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json()).error?.message || ""; } catch (_) {}
      throw new Error("Google Drive (" + response.status + ")" + (detail ? " : " + detail : ""));
    }
    return response;
  }

  async function findBackupFile() {
    const remembered = localStorage.getItem(FILE_ID_KEY);
    if (remembered) {
      const check = await authorizedFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(remembered) + "?fields=id,name,trashed");
      const item = await check.json();
      if (item && !item.trashed) return item;
      localStorage.removeItem(FILE_ID_KEY);
    }
    const q = encodeURIComponent("name = '" + FILE_NAME.replace(/'/g, "\\'") + "' and trashed = false");
    const response = await authorizedFetch("https://www.googleapis.com/drive/v3/files?q=" + q + "&spaces=drive&pageSize=10&fields=files(id,name,modifiedTime)");
    const data = await response.json();
    const file = data.files?.[0] || null;
    if (file?.id) localStorage.setItem(FILE_ID_KEY, file.id);
    return file;
  }

  async function createBackupFile() {
    const response = await authorizedFetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({name: FILE_NAME, mimeType:"application/json"})
    });
    const file = await response.json();
    if (!file.id) throw new Error("Google Drive n'a pas retourné d'identifiant de fichier.");
    localStorage.setItem(FILE_ID_KEY, file.id);
    return file;
  }

  async function uploadState(fileId, data) {
    const response = await authorizedFetch("https://www.googleapis.com/upload/drive/v3/files/" + encodeURIComponent(fileId) + "?uploadType=media", {
      method: "PATCH",
      headers: {"Content-Type":"application/json; charset=UTF-8"},
      body: JSON.stringify(data)
    });
    return response.json().catch(() => ({}));
  }

  async function downloadState(fileId) {
    const response = await authorizedFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?alt=media");
    const data = await response.json();
    if (!Array.isArray(data.wines) || !Array.isArray(data.moves)) throw new Error("Le fichier Drive ne contient pas une sauvegarde Ma Cave valide.");
    return data;
  }

  async function firstSync() {
    if (syncing) return;
    syncing = true;
    try {
      const local = getState();
      let file = await findBackupFile();
      if (!file) {
        file = await createBackupFile();
        await uploadState(file.id, local);
        lastStateFingerprint = fingerprint(local);
        localStorage.setItem(INITIALIZED_KEY, "1");
        status("Première sauvegarde créée sur Google Drive. Votre cave est protégée.", "ok");
        return;
      }

      const remote = await downloadState(file.id);
      if (!hasLocalData(local) && hasLocalData(remote)) {
        localStorage.setItem("ma-cave-v1", JSON.stringify(remote));
        lastStateFingerprint = fingerprint(remote);
        localStorage.setItem(INITIALIZED_KEY, "1");
        if (window.MaCaveReload) window.MaCaveReload();
        status("Votre cave et vos photos ont été restaurées depuis Google Drive.", "ok");
        return;
      }

      if (hasLocalData(local) && hasLocalData(remote) && !localStorage.getItem(INITIALIZED_KEY)) {
        const useRemote = window.confirm("Une sauvegarde Ma Cave existe déjà sur Google Drive.\n\nOK : remplacer les données de cet appareil par la sauvegarde Google Drive.\nAnnuler : conserver les données de cet appareil et les enregistrer sur Google Drive.");
        if (useRemote) {
          localStorage.setItem("ma-cave-v1", JSON.stringify(remote));
          lastStateFingerprint = fingerprint(remote);
          if (window.MaCaveReload) window.MaCaveReload();
          status("La sauvegarde Google Drive a été restaurée sur cet appareil.", "ok");
        } else {
          await uploadState(file.id, local);
          lastStateFingerprint = fingerprint(local);
          status("Les données de cet appareil ont été enregistrées sur Google Drive.", "ok");
        }
      } else {
        await uploadState(file.id, local);
        lastStateFingerprint = fingerprint(local);
        status("Votre cave est synchronisée avec Google Drive.", "ok");
      }
      localStorage.setItem(INITIALIZED_KEY, "1");
    } finally {
      syncing = false;
    }
  }

  async function syncNow() {
    if (syncing) return;
    if (!navigator.onLine) { status("Hors connexion. Les changements restent enregistrés sur le téléphone et seront synchronisés au retour d'Internet.", "pending"); return; }
    syncing = true;
    try {
      const local = getState();
      const localFP = fingerprint(local);
      if (localFP === lastStateFingerprint) {
        status("Votre cave est déjà à jour sur Google Drive.", "ok");
        return;
      }
      status("Synchronisation de votre cave et des photos…");
      let file = await findBackupFile();
      if (!file) file = await createBackupFile();
      await uploadState(file.id, local);
      lastStateFingerprint = localFP;
      status("Sauvegarde Google Drive à jour · " + new Date().toLocaleTimeString("fr-FR", {hour:"2-digit",minute:"2-digit"}), "ok");
    } finally {
      syncing = false;
    }
  }

  function scheduleSync() {
    if (!localStorage.getItem(CONNECTED_KEY)) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncNow().catch(err => {
        console.error(err);
        status("Synchronisation en attente : " + (err.message || "reconnexion Google nécessaire"), "pending");
        setConnectedUI(false);
      });
    }, 1800);
  }

  async function connect() {
    try {
      status("Ouverture de la connexion Google…");
      // Consentement explicite à la première connexion ; Google réutilise ensuite l'autorisation.
      await requestToken(localStorage.getItem(CONNECTED_KEY) ? "" : "consent");
    } catch (err) {
      status(err.message || "Impossible de connecter Google Drive.", "error");
    }
  }

  async function restoreOrUploadAfterConnect() {
    // Intentionally unused: syncNow handles first creation; restore is exposed separately.
  }

  function bindUI() {
    const connectBtn = el("connectDrive");
    const syncBtn = el("syncDrive");
    if (connectBtn) connectBtn.addEventListener("click", connect);
    if (syncBtn) syncBtn.addEventListener("click", () => syncNow().catch(err => status(err.message, "error")));
    if (localStorage.getItem(CONNECTED_KEY)) {
      setConnectedUI(true);
      status("Autorisation Google déjà configurée. Vérification de la connexion…");
      // Pas de fenêtre automatique : l'utilisateur garde le contrôle de l'ouverture Google.
      status("Tentative de reconnexion à Google Drive…", "pending");
      // Une demande silencieuse peut renouveler le jeton si Google dispose déjà du consentement.
      // Si le navigateur exige une interaction, le bouton de reconnexion reste disponible.
      setTimeout(() => {
        if (ensureTokenClient()) {
          requestToken("").catch(() => {
            status("Reconnexion nécessaire : appuyez sur « Reconnecter Google Drive ».", "pending");
            setConnectedUI(false);
          });
        }
      }, 900);
    } else {
      setConnectedUI(false);
    }
    window.addEventListener("online", () => {
      if (localStorage.getItem(CONNECTED_KEY)) scheduleSync();
    });
  }

  window.MaCaveDrive = {scheduleSync, syncNow, connect};
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindUI);
  else bindUI();
})();