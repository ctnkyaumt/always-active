/* global navigation */
{
  /* capture originals before any page code can override */
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  const nativeRequestAnimationFrame = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
  const nativeCancelAnimationFrame = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : null;
  const NativeWorker = window.Worker;
  const NativeBlob = window.Blob;
  const createObjectURL = window.URL && window.URL.createObjectURL ? window.URL.createObjectURL.bind(window.URL) : null;
  const revokeObjectURL = window.URL && window.URL.revokeObjectURL ? window.URL.revokeObjectURL.bind(window.URL) : null;
  const nativeNow = window.performance && window.performance.now ? window.performance.now.bind(window.performance) : () => Date.now();
  const nativeMutedDesc = typeof HTMLMediaElement !== 'undefined' ? Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted') : null;
  const nativeVolumeDesc = typeof HTMLMediaElement !== 'undefined' ? Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume') : null;
  const nativePlay = typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.prototype.play : null;
  const nativePause = typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.prototype.pause : null;

  /* port is used to communicate between chrome and page scripts */
  let port;
  try {
    port = document.getElementById('lwys-ctv-port');
    port.remove();
  }
  catch (e) {
    port = document.createElement('span');
    port.id = 'lwys-ctv-port';
    document.documentElement.append(port);
  }

  const block = e => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  /* worker-backed clock & timers */
  const workerCode = `
    const map = new Map();
    self.onmessage = e => {
      const { cmd, id, delay } = e.data;
      if (cmd === 'set') {
        map.set(id, setTimeout(() => {
          map.delete(id);
          postMessage(id);
        }, delay));
      }
      else if (cmd === 'clear') {
        clearTimeout(map.get(id));
        map.delete(id);
      }
    };
  `;

  let nextId = 2 ** 30;
  const clockPending = new Map();
  const fallbackMap = new Map();
  let worker = null;
  let clockFailed = !NativeWorker || !NativeBlob || !createObjectURL;

  const failClock = () => {
    clockFailed = true;
    if (worker) {
      try {
        worker.terminate();
      }
      catch (e) {}
      worker = null;
    }
    const pending = Array.from(clockPending.entries());
    clockPending.clear();
    for (const [id, cb] of pending) {
      const tid = nativeSetTimeout(() => {
        fallbackMap.delete(id);
        try {
          cb();
        }
        catch (e) {
          queueMicrotask(() => { throw e; });
        }
      }, 0);
      fallbackMap.set(id, tid);
    }
  };

  const initWorker = () => {
    if (worker || clockFailed) {
      return !clockFailed;
    }
    try {
      const blob = new NativeBlob([workerCode], { type: 'text/javascript' });
      const url = createObjectURL(blob);
      try {
        worker = new NativeWorker(url);
      }
      finally {
        if (revokeObjectURL) {
          revokeObjectURL(url);
        }
      }
      worker.onmessage = e => {
        const id = e.data;
        const cb = clockPending.get(id);
        if (cb) {
          clockPending.delete(id);
          cb();
        }
      };
      worker.onerror = e => {
        if (e && e.preventDefault) {
          e.preventDefault();
        }
        failClock();
      };
      return true;
    }
    catch (e) {
      failClock();
      return false;
    }
  };

  const clock = {
    get available() {
      if (!worker && !clockFailed) {
        initWorker();
      }
      return !clockFailed;
    },
    set(cb, delay) {
      const id = ++nextId;
      if (clock.available && worker) {
        clockPending.set(id, cb);
        try {
          worker.postMessage({ cmd: 'set', id, delay });
        }
        catch (e) {
          clockPending.delete(id);
          failClock();
          const tid = nativeSetTimeout(() => {
            fallbackMap.delete(id);
            cb();
          }, delay);
          fallbackMap.set(id, tid);
        }
      }
      else {
        const tid = nativeSetTimeout(() => {
          fallbackMap.delete(id);
          cb();
        }, delay);
        fallbackMap.set(id, tid);
      }
      return id;
    },
    clear(id) {
      if (fallbackMap.has(id)) {
        const tid = fallbackMap.get(id);
        fallbackMap.delete(id);
        nativeClearTimeout(tid);
      }
      if (clockPending.has(id)) {
        clockPending.delete(id);
        if (worker) {
          try {
            worker.postMessage({ cmd: 'clear', id });
          }
          catch (e) {}
        }
      }
    }
  };

  const activeTimers = new Map();

  window.setTimeout = new Proxy(window.setTimeout, {
    apply(target, self, args) {
      if (port.dataset.enabled === 'true' && port.dataset.timers !== 'false' && typeof args[0] === 'function' && clock.available) {
        const id = ++nextId;
        const delay = Math.max(0, Number(args[1]) || 0);
        const restArgs = args.slice(2);
        const handler = args[0];
        const clockId = clock.set(() => {
          activeTimers.delete(id);
          try {
            handler.apply(window, restArgs);
          }
          catch (e) {
            queueMicrotask(() => { throw e; });
          }
        }, delay);
        activeTimers.set(id, { clockId });
        return id;
      }
      return Reflect.apply(target, self, args);
    }
  });

  window.setInterval = new Proxy(window.setInterval, {
    apply(target, self, args) {
      if (port.dataset.enabled === 'true' && port.dataset.timers !== 'false' && typeof args[0] === 'function' && clock.available) {
        const id = ++nextId;
        const delay = Math.max(4, Number(args[1]) || 0);
        const restArgs = args.slice(2);
        const handler = args[0];
        const step = () => {
          if (!activeTimers.has(id)) {
            return;
          }
          const nextClockId = clock.set(step, delay);
          activeTimers.set(id, { clockId: nextClockId });
          try {
            handler.apply(window, restArgs);
          }
          catch (e) {
            queueMicrotask(() => { throw e; });
          }
        };
        const clockId = clock.set(step, delay);
        activeTimers.set(id, { clockId });
        return id;
      }
      return Reflect.apply(target, self, args);
    }
  });

  const clearTimer = (target, self, args) => {
    const id = Number(args[0]);
    if (activeTimers.has(id)) {
      const timer = activeTimers.get(id);
      activeTimers.delete(id);
      clock.clear(timer.clockId);
      return;
    }
    else if (Number.isInteger(id) && id >= 2 ** 30) {
      return;
    }
    return Reflect.apply(target, self, args);
  };

  window.clearTimeout = new Proxy(window.clearTimeout, {
    apply: clearTimer
  });
  window.clearInterval = new Proxy(window.clearInterval, {
    apply: clearTimer
  });

  /* requestAnimationFrame */
  const nativeRafs = new Map();
  const rafBatch = new Map();
  let lastTick = 0;
  let rafPending = false;

  const scheduleTick = () => {
    if (!rafPending) {
      rafPending = true;
      clock.set(tick, Math.max(0, 16 - (nativeNow() - lastTick)));
    }
  };

  const tick = () => {
    rafPending = false;
    lastTick = nativeNow();
    const callbacks = Array.from(rafBatch.values());
    rafBatch.clear();
    const frameTime = nativeNow();
    for (const cb of callbacks) {
      try {
        cb(frameTime);
      }
      catch (e) {
        queueMicrotask(() => { throw e; });
      }
    }
  };

  if (window.requestAnimationFrame) {
    window.requestAnimationFrame = new Proxy(window.requestAnimationFrame, {
      apply(target, self, args) {
        const cb = args[0];
        if (typeof cb !== 'function') {
          return Reflect.apply(target, self, args);
        }
        const id = ++nextId;
        if (port.dataset.enabled === 'true' && port.dataset.hidden === 'true') {
          rafBatch.set(id, cb);
          scheduleTick();
          return id;
        }
        const wrapper = ts => {
          nativeRafs.delete(id);
          cb(ts);
        };
        const nativeId = Reflect.apply(target, self, [wrapper]);
        nativeRafs.set(id, { nativeId, cb });
        return id;
      }
    });
  }

  if (window.cancelAnimationFrame) {
    window.cancelAnimationFrame = new Proxy(window.cancelAnimationFrame, {
      apply(target, self, args) {
        const id = Number(args[0]);
        if (rafBatch.has(id)) {
          rafBatch.delete(id);
          return;
        }
        else if (nativeRafs.has(id)) {
          const entry = nativeRafs.get(id);
          nativeRafs.delete(id);
          if (nativeCancelAnimationFrame) {
            nativeCancelAnimationFrame(entry.nativeId);
          }
          else {
            Reflect.apply(target, self, [entry.nativeId]);
          }
          return;
        }
        else if (Number.isInteger(id) && id >= 2 ** 30) {
          return;
        }
        return Reflect.apply(target, self, args);
      }
    });
  }

  /* media handling (keep muted audio/video playing while hidden) */
  let paintAllVideos = () => {};
  if (typeof HTMLMediaElement !== 'undefined') {
    const mediaStates = new WeakMap();
    const playingVideos = new Set();
    const pagePausedMedia = new WeakSet();

    let sharedCanvas = null;
    let sharedCtx = null;
    const getSharedCtx = () => {
      if (!sharedCtx) {
        try {
          if (typeof OffscreenCanvas !== 'undefined') {
            sharedCanvas = new OffscreenCanvas(1, 1);
            sharedCtx = sharedCanvas.getContext('2d');
          }
        }
        catch (e) {}
        if (!sharedCtx && typeof document !== 'undefined' && document.createElement) {
          try {
            sharedCanvas = document.createElement('canvas');
            sharedCanvas.width = 1;
            sharedCanvas.height = 1;
            sharedCtx = sharedCanvas.getContext('2d');
          }
          catch (e) {}
        }
      }
      return sharedCtx;
    };

    const paintVideo = video => {
      if (video && video.readyState >= 2) {
        const ctx = getSharedCtx();
        if (ctx) {
          try {
            ctx.drawImage(video, 0, 0, 1, 1);
          }
          catch (e) {}
        }
      }
    };

    paintAllVideos = () => {
      for (const video of playingVideos) {
        paintVideo(video);
      }
    };

    const isMediaActive = () => port.dataset.enabled === 'true' && port.dataset.media !== 'false';

    let videoKeepAlivePending = false;
    const scheduleVideoKeepAlive = () => {
      if (videoKeepAlivePending || playingVideos.size === 0 || !isMediaActive()) {
        return;
      }
      videoKeepAlivePending = true;
      clock.set(() => {
        videoKeepAlivePending = false;
        if (playingVideos.size > 0 && isMediaActive()) {
          paintAllVideos();
          scheduleVideoKeepAlive();
        }
      }, 2000);
    };

    const addPlayingVideo = video => {
      if (typeof HTMLVideoElement !== 'undefined' && video instanceof HTMLVideoElement && isMediaActive()) {
        playingVideos.add(video);
        paintVideo(video);
        scheduleVideoKeepAlive();
      }
    };

    const removePlayingVideo = video => {
      if (typeof HTMLVideoElement !== 'undefined' && video instanceof HTMLVideoElement) {
        playingVideos.delete(video);
      }
    };

    const applyMediaState = (el, state) => {
      if (nativeMutedDesc && nativeMutedDesc.set) {
        nativeMutedDesc.set.call(el, false);
      }
      if (nativeVolumeDesc && nativeVolumeDesc.set) {
        nativeVolumeDesc.set.call(el, state.muted ? 0 : state.volume);
      }
    };

    const adoptMedia = el => {
      if (!isMediaActive() || mediaStates.has(el)) {
        return;
      }
      const currentMuted = nativeMutedDesc && nativeMutedDesc.get ? nativeMutedDesc.get.call(el) : el.muted;
      const currentVolume = nativeVolumeDesc && nativeVolumeDesc.get ? nativeVolumeDesc.get.call(el) : el.volume;
      const state = {
        muted: !!currentMuted,
        volume: typeof currentVolume === 'number' ? currentVolume : 1
      };
      mediaStates.set(el, state);
      applyMediaState(el, state);
    };

    if (nativePlay) {
      HTMLMediaElement.prototype.play = new Proxy(nativePlay, {
        apply(target, self, args) {
          if (self instanceof HTMLMediaElement) {
            pagePausedMedia.delete(self);
            if (isMediaActive()) {
              adoptMedia(self);
              if (typeof HTMLVideoElement !== 'undefined' && self instanceof HTMLVideoElement) {
                addPlayingVideo(self);
              }
            }
          }
          return Reflect.apply(target, self, args);
        }
      });
    }

    if (nativePause) {
      HTMLMediaElement.prototype.pause = new Proxy(nativePause, {
        apply(target, self, args) {
          if (self instanceof HTMLMediaElement) {
            pagePausedMedia.add(self);
            removePlayingVideo(self);
          }
          return Reflect.apply(target, self, args);
        }
      });
    }

    const onMediaPlay = e => {
      const el = e.target;
      if (el instanceof HTMLMediaElement) {
        pagePausedMedia.delete(el);
        if (isMediaActive()) {
          const wasAdopted = mediaStates.has(el);
          adoptMedia(el);
          if (typeof HTMLVideoElement !== 'undefined' && el instanceof HTMLVideoElement) {
            addPlayingVideo(el);
          }
          if (!wasAdopted) {
            const state = mediaStates.get(el);
            if (state && state.muted && !el.paused) {
              try {
                nativePlay.call(el).catch(() => {});
              }
              catch (err) {}
            }
          }
        }
      }
    };
    document.addEventListener('play', onMediaPlay, true);
    document.addEventListener('playing', onMediaPlay, true);

    document.addEventListener('pause', e => {
      const el = e.target;
      if (el instanceof HTMLMediaElement) {
        removePlayingVideo(el);
        const byPage = pagePausedMedia.has(el);
        if (!byPage && isMediaActive() && port.dataset.hidden === 'true' && !el.ended) {
          if (typeof HTMLVideoElement !== 'undefined' && el instanceof HTMLVideoElement) {
            paintVideo(el);
            addPlayingVideo(el);
          }
          try {
            nativePlay.call(el).catch(() => {});
          }
          catch (err) {}
        }
      }
    }, true);

    document.addEventListener('ended', e => {
      if (e.target instanceof HTMLMediaElement) {
        removePlayingVideo(e.target);
      }
    }, true);

    document.addEventListener('emptied', e => {
      if (e.target instanceof HTMLMediaElement) {
        removePlayingVideo(e.target);
      }
    }, true);

    Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
      configurable: true,
      enumerable: nativeMutedDesc ? nativeMutedDesc.enumerable : true,
      get() {
        const state = mediaStates.get(this);
        if (state) {
          return state.muted;
        }
        return nativeMutedDesc && nativeMutedDesc.get ? nativeMutedDesc.get.call(this) : this.muted;
      },
      set(val) {
        const state = mediaStates.get(this);
        if (state) {
          const changed = state.muted !== !!val;
          state.muted = !!val;
          applyMediaState(this, state);
          if (changed) {
            this.dispatchEvent(new Event('volumechange'));
          }
        }
        else {
          if (isMediaActive()) {
            adoptMedia(this);
            const newState = mediaStates.get(this);
            if (newState) {
              const changed = newState.muted !== !!val;
              newState.muted = !!val;
              applyMediaState(this, newState);
              if (changed) {
                this.dispatchEvent(new Event('volumechange'));
              }
              return;
            }
          }
          if (nativeMutedDesc && nativeMutedDesc.set) {
            nativeMutedDesc.set.call(this, val);
          }
        }
      }
    });

    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      configurable: true,
      enumerable: nativeVolumeDesc ? nativeVolumeDesc.enumerable : true,
      get() {
        const state = mediaStates.get(this);
        if (state) {
          return state.volume;
        }
        return nativeVolumeDesc && nativeVolumeDesc.get ? nativeVolumeDesc.get.call(this) : this.volume;
      },
      set(val) {
        const num = Number(val);
        if (isNaN(num) || num < 0 || num > 1) {
          throw new DOMException("Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (" + val + ") is outside the range [0, 1].", 'IndexSizeError');
        }
        const state = mediaStates.get(this);
        if (state) {
          const changed = state.volume !== num;
          state.volume = num;
          applyMediaState(this, state);
          if (changed) {
            this.dispatchEvent(new Event('volumechange'));
          }
        }
        else {
          if (isMediaActive()) {
            adoptMedia(this);
            const newState = mediaStates.get(this);
            if (newState) {
              const changed = newState.volume !== num;
              newState.volume = num;
              applyMediaState(this, newState);
              if (changed) {
                this.dispatchEvent(new Event('volumechange'));
              }
              return;
            }
          }
          if (nativeVolumeDesc && nativeVolumeDesc.set) {
            nativeVolumeDesc.set.call(this, num);
          }
        }
      }
    });

    document.addEventListener('volumechange', e => {
      if (mediaStates.has(e.target) && e.isTrusted) {
        e.stopImmediatePropagation();
      }
    }, true);
  }

  /* visibility */
  Object.defineProperty(document, 'visibilityState', {
    get() {
      if (port.dataset.enabled === 'false') {
        return port.dataset.hidden === 'true' ? 'hidden' : 'visible';
      }
      return 'visible';
    }
  });
  Object.defineProperty(document, 'webkitVisibilityState', {
    get() {
      if (port.dataset.enabled === 'false') {
        return port.dataset.hidden === 'true' ? 'hidden' : 'visible';
      }
      return 'visible';
    }
  });

  const vstate = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  const cstate = vstate.get.call(document);
  const once = {
    focus: true,
    // if document is hidden allow one time event
    visibilitychange: cstate === 'hidden',
    webkitvisibilitychange: cstate === 'hidden'
  };

  /* prevent redirect when hidden */
  if (window.top === window && typeof navigation !== 'undefined') {
    // Save the original property descriptor
    const redirect = e => {
      if (redirect.href) {
        console.info('[Always Active]', 'an attempt to redirect is being blocked', redirect.href);
        e.preventDefault();
        e.returnValue = 'no';
      }
    };
    navigation.addEventListener('navigate', navigateEvent => {
      if (navigateEvent.navigationType === 'reload') {
        redirect.href = navigateEvent.destination.url;
      }
    });
    document.addEventListener('visibilitychange', e => {
      delete redirect.href;
      removeEventListener('beforeunload', redirect);
      try {
        const state = vstate.get.call(document);
        if (state === 'hidden') {
          if (port.dataset.enabled === 'true' && port.dataset.redirect !== 'false') {
            addEventListener('beforeunload', redirect);
          }
        }
      }
      catch (e) {}
    });
  }

  document.addEventListener('visibilitychange', e => {
    port.dispatchEvent(new Event('state'));
    if (port.dataset.enabled === 'true' && port.dataset.hidden === 'true') {
      for (const [id, entry] of nativeRafs) {
        if (nativeCancelAnimationFrame) {
          nativeCancelAnimationFrame(entry.nativeId);
        }
        rafBatch.set(id, entry.cb);
      }
      nativeRafs.clear();
      scheduleTick();
      if (typeof paintAllVideos === 'function') {
        paintAllVideos();
      }
    }
    if (port.dataset.enabled === 'true' && port.dataset.visibility !== 'false') {
      if (once.visibilitychange) {
        once.visibilitychange = false;
        return;
      }
      return block(e);
    }
  }, true);
  document.addEventListener('webkitvisibilitychange', e => {
    if (port.dataset.enabled === 'true' && port.dataset.visibility !== 'false') {
      if (once.webkitvisibilitychange) {
        once.webkitvisibilitychange = false;
        return;
      }
      return block(e);
    }
  }, true);
  window.addEventListener('pagehide', e => {
    if (port.dataset.enabled === 'true' && port.dataset.visibility !== 'false') {
      block(e);
    }
  }, true);

  /* pointercapture */
  window.addEventListener('lostpointercapture', e => {
    if (port.dataset.enabled === 'true' && port.dataset.pointercapture !== 'false') {
      block(e);
    }
  }, true);

  /* hidden */
  Object.defineProperty(document, 'hidden', {
    get() {
      if (port.dataset.enabled === 'false') {
        return port.dataset.hidden === 'true';
      }
      return false;
    }
  });
  Object.defineProperty(document, 'webkitHidden', {
    get() {
      if (port.dataset.enabled === 'false') {
        return port.dataset.hidden === 'true';
      }
      return false;
    }
  });

  /* focus */
  Document.prototype.hasFocus = new Proxy(Document.prototype.hasFocus, {
    apply(target, self, args) {
      if (port.dataset.enabled === 'true' && port.dataset.focus !== 'false') {
        return true;
      }
      return Reflect.apply(target, self, args);
    }
  });

  const onfocus = e => {
    if (port.dataset.enabled === 'true' && port.dataset.focus !== 'false') {
      if (e.target === document || e.target === window) {
        if (once.focus) {
          once.focus = false;
          return;
        }
        return block(e);
      }
    }
  };
  document.addEventListener('focus', onfocus, true);
  window.addEventListener('focus', onfocus, true);

  /* blur */
  const onblur = e => {
    if (port.dataset.enabled === 'true' && port.dataset.blur !== 'false') {
      if (e.target === document || e.target === window) {
        return block(e);
      }
    }
  };
  document.addEventListener('blur', onblur, true);
  window.addEventListener('blur', onblur, true);

  /* mouse */
  window.addEventListener('mouseleave', e => {
    if (port.dataset.enabled === 'true' && port.dataset.mouseleave !== 'false') {
      if (e.target === document || e.target === window) {
        return block(e);
      }
    }
  }, true);
  window.addEventListener('mouseout', e => {
    if (port.dataset.enabled === 'true' && port.dataset.mouseout !== 'false') {
      if (e.target === document.documentElement || e.target === document.body) {
        return block(e);
      }
    }
  }, true);

  /* fullscreen protection (optional): keeps the page believing it is still fullscreen
     after the browser force-exits fullscreen on a hidden tab. The option is off by default;
     until it is enabled, the script touches nothing at all (no listeners, no overwrites).
     Once enabled, while the page is visible the fullscreen events pass through and only
     the real state is recorded; while the page is hidden, the events are blocked and the
     recorded state is spoofed. Toggling the pref installs or fully removes the protection
     on the fly. */
  {
    /* original descriptors (captured before any overwrite; invisible to the page) */
    const fele = Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenElement');
    const wfele = Object.getOwnPropertyDescriptor(Document.prototype, 'webkitFullscreenElement');
    const target = fele || wfele;

    /* the recorded state (persists across the hidden period) */
    const real = {
      element: null
    };
    const realElement = () => {
      try {
        return target ? target.get.call(document) : null;
      }
      catch (e) {
        return null;
      }
    };
    const grab = () => {
      real.element = realElement();
    };

    const protectedState = () => port.dataset.enabled === 'true' &&
      port.dataset.fullscreen !== 'false' &&
      port.dataset.hidden === 'true';

    const element = () => protectedState() ? real.element : realElement();
    const bool = () => !!element();

    const onfullscreen = e => {
      /* always track the real state; block the page's handlers only while hidden */
      grab();
      if (protectedState()) {
        return block(e);
      }
    };
    const onfullscreenerror = e => {
      if (protectedState()) {
        return block(e);
      }
    };

    const install = () => {
      grab();
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: element
      });
      Object.defineProperty(document, 'webkitFullscreenElement', {
        configurable: true,
        get: element
      });
      Object.defineProperty(document, 'fullscreen', {
        configurable: true,
        get: bool
      });
      Object.defineProperty(document, 'webkitIsFullScreen', {
        configurable: true,
        get: bool
      });
      document.addEventListener('fullscreenchange', onfullscreen, true);
      document.addEventListener('webkitfullscreenchange', onfullscreen, true);
      window.addEventListener('fullscreenchange', onfullscreen, true);
      window.addEventListener('webkitfullscreenchange', onfullscreen, true);
      document.addEventListener('fullscreenerror', onfullscreenerror, true);
      document.addEventListener('webkitfullscreenerror', onfullscreenerror, true);
      window.addEventListener('fullscreenerror', onfullscreenerror, true);
      window.addEventListener('webkitfullscreenerror', onfullscreenerror, true);

      install.active = true;
    };
    const uninstall = () => {
      document.removeEventListener('fullscreenchange', onfullscreen, true);
      document.removeEventListener('webkitfullscreenchange', onfullscreen, true);
      window.removeEventListener('fullscreenchange', onfullscreen, true);
      window.removeEventListener('webkitfullscreenchange', onfullscreen, true);
      document.removeEventListener('fullscreenerror', onfullscreenerror, true);
      document.removeEventListener('webkitfullscreenerror', onfullscreenerror, true);
      window.removeEventListener('fullscreenerror', onfullscreenerror, true);
      window.removeEventListener('webkitfullscreenerror', onfullscreenerror, true);
      for (const prop of ['fullscreenElement', 'webkitFullscreenElement', 'fullscreen', 'webkitIsFullScreen']) {
        delete document[prop];
      }
      real.element = null;

      install.active = false;
    };

    /* the decision is delivered by the ISOLATED world through the port element;
       until it arrives (or unless it is "true"), nothing is installed */
    const toggle = () => {
      if (port.dataset.fullscreen === 'true' && !install.active) {
        install();
      }
      else if (port.dataset.fullscreen !== 'true' && install.active) {
        uninstall();
      }
    };
    const check = () => {
      toggle();
      if (port.dataset.fullscreen === undefined) {
        nativeSetTimeout(check, 4);
      }
    };
    check();

    /* live install/uninstall when the pref (or a per-host policy) changes */
    port.addEventListener('fs', toggle);
  }
}

''
