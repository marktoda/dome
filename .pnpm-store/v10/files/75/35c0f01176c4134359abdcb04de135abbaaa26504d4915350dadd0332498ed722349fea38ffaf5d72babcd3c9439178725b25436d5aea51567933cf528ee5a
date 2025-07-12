'use strict';

var chunkP3Q73CAW_cjs = require('../chunk-P3Q73CAW.cjs');
var chunkZIZ3CVHN_cjs = require('../chunk-ZIZ3CVHN.cjs');
var crypto = require('crypto');
var slugify = require('@sindresorhus/slugify');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var slugify__default = /*#__PURE__*/_interopDefault(slugify);

var MCPServerBase = class extends chunkP3Q73CAW_cjs.MastraBase {
  /** Tracks if the server ID has been definitively set. */
  idWasSet = false;
  /** The display name of the MCP server. */
  name;
  /** The semantic version of the MCP server. */
  version;
  /** Internal storage for the server's unique ID. */
  _id;
  /** A description of what the MCP server does. */
  description;
  /** Repository information for the server's source code. */
  repository;
  /** The release date of this server version (ISO 8601 string). */
  releaseDate;
  /** Indicates if this version is the latest available. */
  isLatest;
  /** The canonical packaging format (e.g., "npm", "docker"), if applicable. */
  packageCanonical;
  /** Information about installable packages for this server. */
  packages;
  /** Information about remote access points for this server. */
  remotes;
  /** The tools registered with and converted by this MCP server. */
  convertedTools;
  /** Reference to the Mastra instance if this server is registered with one. */
  mastra;
  /** Agents to be exposed as tools. */
  agents;
  /** Workflows to be exposed as tools. */
  workflows;
  /**
   * Public getter for the server's unique ID.
   * The ID is set at construction or by Mastra and is read-only afterwards.
   */
  get id() {
    return this._id;
  }
  /**
   * Gets a read-only view of the registered tools.
   * @returns A readonly record of converted tools.
   */
  tools() {
    return this.convertedTools;
  }
  /**
   * Sets the server's unique ID. This method is typically called by Mastra when
   * registering the server, using the key provided in the Mastra configuration.
   * It ensures the ID is set only once.
   * If an ID was already provided in the MCPServerConfig, this method will be a no-op.
   * @param id The unique ID to assign to the server.
   */
  setId(id) {
    if (this.idWasSet) {
      return;
    }
    this._id = id;
    this.idWasSet = true;
  }
  /**
   * Internal method used by Mastra to register itself with the server.
   * @param mastra The Mastra instance.
   * @internal
   */
  __registerMastra(mastra) {
    this.mastra = mastra;
  }
  /**
   * Constructor for the MCPServerBase.
   * @param config Configuration options for the MCP server, including metadata.
   */
  constructor(config) {
    super({ component: chunkZIZ3CVHN_cjs.RegisteredLogger.MCP_SERVER, name: config.name });
    this.name = config.name;
    this.version = config.version;
    if (config.id) {
      this._id = slugify__default.default(config.id);
      this.idWasSet = true;
    } else {
      this._id = crypto.randomUUID();
    }
    this.description = config.description;
    this.repository = config.repository;
    this.releaseDate = config.releaseDate || (/* @__PURE__ */ new Date()).toISOString();
    this.isLatest = config.isLatest === void 0 ? true : config.isLatest;
    this.packageCanonical = config.packageCanonical;
    this.packages = config.packages;
    this.remotes = config.remotes;
    this.agents = config.agents;
    this.workflows = config.workflows;
    this.convertedTools = this.convertTools(config.tools, config.agents, config.workflows);
  }
};

exports.MCPServerBase = MCPServerBase;
