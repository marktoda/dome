'use strict';

var chunkQQ5K5TZE_cjs = require('./chunk-QQ5K5TZE.cjs');
var chunkB6TOBUS6_cjs = require('./chunk-B6TOBUS6.cjs');
var chunkP3Q73CAW_cjs = require('./chunk-P3Q73CAW.cjs');
var chunkU64IJDC5_cjs = require('./chunk-U64IJDC5.cjs');

// src/voice/voice.ts
var _MastraVoice_decorators, _init, _a;
_MastraVoice_decorators = [chunkQQ5K5TZE_cjs.InstrumentClass({
  prefix: "voice",
  excludeMethods: ["__setTools", "__setLogger", "__setTelemetry", "#log"]
})];
exports.MastraVoice = class MastraVoice extends (_a = chunkP3Q73CAW_cjs.MastraBase) {
  listeningModel;
  speechModel;
  speaker;
  realtimeConfig;
  constructor({
    listeningModel,
    speechModel,
    speaker,
    realtimeConfig,
    name
  } = {}) {
    super({
      component: "VOICE",
      name
    });
    this.listeningModel = listeningModel;
    this.speechModel = speechModel;
    this.speaker = speaker;
    this.realtimeConfig = realtimeConfig;
  }
  traced(method, methodName) {
    return this.telemetry?.traceMethod(method, {
      spanName: `voice.${methodName}`,
      attributes: {
        "voice.type": this.speechModel?.name || this.listeningModel?.name || "unknown"
      }
    }) ?? method;
  }
  updateConfig(_options) {
    this.logger.warn("updateConfig not implemented by this voice provider");
  }
  /**
   * Initializes a WebSocket or WebRTC connection for real-time communication
   * @returns Promise that resolves when the connection is established
   */
  connect(_options) {
    this.logger.warn("connect not implemented by this voice provider");
    return Promise.resolve();
  }
  /**
   * Relay audio data to the voice provider for real-time processing
   * @param audioData Audio data to relay
   */
  send(_audioData) {
    this.logger.warn("relay not implemented by this voice provider");
    return Promise.resolve();
  }
  /**
   * Trigger voice providers to respond
   */
  answer(_options) {
    this.logger.warn("answer not implemented by this voice provider");
    return Promise.resolve();
  }
  /**
   * Equip the voice provider with instructions
   * @param instructions Instructions to add
   */
  addInstructions(_instructions) {}
  /**
   * Equip the voice provider with tools
   * @param tools Array of tools to add
   */
  addTools(_tools) {}
  /**
   * Disconnect from the WebSocket or WebRTC connection
   */
  close() {
    this.logger.warn("close not implemented by this voice provider");
  }
  /**
   * Register an event listener
   * @param event Event name (e.g., 'speaking', 'writing', 'error')
   * @param callback Callback function that receives event data
   */
  on(_event, _callback) {
    this.logger.warn("on not implemented by this voice provider");
  }
  /**
   * Remove an event listener
   * @param event Event name (e.g., 'speaking', 'writing', 'error')
   * @param callback Callback function to remove
   */
  off(_event, _callback) {
    this.logger.warn("off not implemented by this voice provider");
  }
  /**
   * Get available speakers/voices
   * @returns Array of available voice IDs and their metadata
   */
  getSpeakers() {
    this.logger.warn("getSpeakers not implemented by this voice provider");
    return Promise.resolve([]);
  }
  /**
   * Get available speakers/voices
   * @returns Array of available voice IDs and their metadata
   */
  getListener() {
    this.logger.warn("getListener not implemented by this voice provider");
    return Promise.resolve({
      enabled: false
    });
  }
};
exports.MastraVoice = /*@__PURE__*/(_ => {
  _init = chunkU64IJDC5_cjs.__decoratorStart(_a);
  exports.MastraVoice = chunkU64IJDC5_cjs.__decorateElement(_init, 0, "MastraVoice", _MastraVoice_decorators, exports.MastraVoice);
  chunkU64IJDC5_cjs.__runInitializers(_init, 1, exports.MastraVoice);

  // src/voice/composite-voice.ts
  return exports.MastraVoice;
})();
// src/voice/composite-voice.ts
var CompositeVoice = class extends exports.MastraVoice {
  speakProvider;
  listenProvider;
  realtimeProvider;
  constructor({
    input,
    output,
    realtime,
    speakProvider,
    listenProvider,
    realtimeProvider
  }) {
    super();
    this.speakProvider = output || speakProvider;
    this.listenProvider = input || listenProvider;
    this.realtimeProvider = realtime || realtimeProvider;
  }
  /**
   * Convert text to speech using the configured provider
   * @param input Text or text stream to convert to speech
   * @param options Speech options including speaker and provider-specific options
   * @returns Audio stream or void if in realtime mode
   */
  async speak(input, options) {
    if (this.realtimeProvider) {
      return this.realtimeProvider.speak(input, options);
    } else if (this.speakProvider) {
      return this.speakProvider.speak(input, options);
    }
    throw new chunkB6TOBUS6_cjs.MastraError({
      id: "VOICE_COMPOSITE_NO_SPEAK_PROVIDER",
      text: "No speak provider or realtime provider configured",
      domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
      category: "USER" /* USER */
    });
  }
  async listen(audioStream, options) {
    if (this.realtimeProvider) {
      return await this.realtimeProvider.listen(audioStream, options);
    } else if (this.listenProvider) {
      return await this.listenProvider.listen(audioStream, options);
    }
    throw new chunkB6TOBUS6_cjs.MastraError({
      id: "VOICE_COMPOSITE_NO_LISTEN_PROVIDER",
      text: "No listen provider or realtime provider configured",
      domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
      category: "USER" /* USER */
    });
  }
  async getSpeakers() {
    if (this.realtimeProvider) {
      return this.realtimeProvider.getSpeakers();
    } else if (this.speakProvider) {
      return this.speakProvider.getSpeakers();
    }
    throw new chunkB6TOBUS6_cjs.MastraError({
      id: "VOICE_COMPOSITE_NO_SPEAKERS_PROVIDER",
      text: "No speak provider or realtime provider configured",
      domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
      category: "USER" /* USER */
    });
  }
  async getListener() {
    if (this.realtimeProvider) {
      return this.realtimeProvider.getListener();
    } else if (this.listenProvider) {
      return this.listenProvider.getListener();
    }
    throw new chunkB6TOBUS6_cjs.MastraError({
      id: "VOICE_COMPOSITE_NO_LISTENER_PROVIDER",
      text: "No listener provider or realtime provider configured",
      domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
      category: "USER" /* USER */
    });
  }
  updateConfig(options) {
    if (!this.realtimeProvider) {
      return;
    }
    this.realtimeProvider.updateConfig(options);
  }
  /**
   * Initializes a WebSocket or WebRTC connection for real-time communication
   * @returns Promise that resolves when the connection is established
   */
  connect(options) {
    if (!this.realtimeProvider) {
      throw new chunkB6TOBUS6_cjs.MastraError({
        id: "VOICE_COMPOSITE_NO_REALTIME_PROVIDER_CONNECT",
        text: "No realtime provider configured",
        domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
        category: "USER" /* USER */
      });
    }
    return this.realtimeProvider.connect(options);
  }
  /**
   * Relay audio data to the voice provider for real-time processing
   * @param audioData Audio data to send
   */
  send(audioData) {
    if (!this.realtimeProvider) {
      throw new chunkB6TOBUS6_cjs.MastraError({
        id: "VOICE_COMPOSITE_NO_REALTIME_PROVIDER_SEND",
        text: "No realtime provider configured",
        domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
        category: "USER" /* USER */
      });
    }
    return this.realtimeProvider.send(audioData);
  }
  /**
   * Trigger voice providers to respond
   */
  answer(options) {
    if (!this.realtimeProvider) {
      throw new chunkB6TOBUS6_cjs.MastraError({
        id: "VOICE_COMPOSITE_NO_REALTIME_PROVIDER_ANSWER",
        text: "No realtime provider configured",
        domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
        category: "USER" /* USER */
      });
    }
    return this.realtimeProvider.answer(options);
  }
  /**
   * Equip the voice provider with instructions
   * @param instructions Instructions to add
   */
  addInstructions(instructions) {
    if (!this.realtimeProvider) {
      return;
    }
    this.realtimeProvider.addInstructions(instructions);
  }
  /**
   * Equip the voice provider with tools
   * @param tools Array of tools to add
   */
  addTools(tools) {
    if (!this.realtimeProvider) {
      return;
    }
    this.realtimeProvider.addTools(tools);
  }
  /**
   * Disconnect from the WebSocket or WebRTC connection
   */
  close() {
    if (!this.realtimeProvider) {
      throw new chunkB6TOBUS6_cjs.MastraError({
        id: "VOICE_COMPOSITE_NO_REALTIME_PROVIDER_CLOSE",
        text: "No realtime provider configured",
        domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
        category: "USER" /* USER */
      });
    }
    this.realtimeProvider.close();
  }
  /**
   * Register an event listener
   * @param event Event name (e.g., 'speaking', 'writing', 'error')
   * @param callback Callback function that receives event data
   */
  on(event, callback) {
    if (!this.realtimeProvider) {
      throw new chunkB6TOBUS6_cjs.MastraError({
        id: "VOICE_COMPOSITE_NO_REALTIME_PROVIDER_ON",
        text: "No realtime provider configured",
        domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
        category: "USER" /* USER */
      });
    }
    this.realtimeProvider.on(event, callback);
  }
  /**
   * Remove an event listener
   * @param event Event name (e.g., 'speaking', 'writing', 'error')
   * @param callback Callback function to remove
   */
  off(event, callback) {
    if (!this.realtimeProvider) {
      throw new chunkB6TOBUS6_cjs.MastraError({
        id: "VOICE_COMPOSITE_NO_REALTIME_PROVIDER_OFF",
        text: "No realtime provider configured",
        domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
        category: "USER" /* USER */
      });
    }
    this.realtimeProvider.off(event, callback);
  }
};

// src/voice/default-voice.ts
var DefaultVoice = class extends exports.MastraVoice {
  constructor() {
    super();
  }
  async speak(_input) {
    throw new chunkB6TOBUS6_cjs.MastraError({
      id: "VOICE_DEFAULT_NO_SPEAK_PROVIDER",
      text: "No voice provider configured",
      domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
      category: "USER" /* USER */
    });
  }
  async listen(_input) {
    throw new chunkB6TOBUS6_cjs.MastraError({
      id: "VOICE_DEFAULT_NO_LISTEN_PROVIDER",
      text: "No voice provider configured",
      domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
      category: "USER" /* USER */
    });
  }
  async getSpeakers() {
    throw new chunkB6TOBUS6_cjs.MastraError({
      id: "VOICE_DEFAULT_NO_SPEAKERS_PROVIDER",
      text: "No voice provider configured",
      domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
      category: "USER" /* USER */
    });
  }
  async getListener() {
    throw new chunkB6TOBUS6_cjs.MastraError({
      id: "VOICE_DEFAULT_NO_LISTENER_PROVIDER",
      text: "No voice provider configured",
      domain: "MASTRA_VOICE" /* MASTRA_VOICE */,
      category: "USER" /* USER */
    });
  }
};

exports.CompositeVoice = CompositeVoice;
exports.DefaultVoice = DefaultVoice;
