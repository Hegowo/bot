import {
  AkairoClient,
  InhibitorHandler,
  ListenerHandler,
  version as akairover,
} from "discord-akairo";
import {
  categoryChannelSilentTypeCaster,
  categoryChannelTypeCaster,
} from "../src/arguments/category";
import {
  textChannelSilentTypeCaster,
  textChannelTypeCaster,
} from "../src/arguments/textChannel";
import {
  guildChannelSilentTypeCaster,
  guildChannelTypeCaster,
} from "../src/arguments/guildChannel";
import {
  memberSilentTypeCaster,
  memberTypeCaster,
} from "../src/arguments/member";
import { memberRoleChannelCategoryTypeCaster } from "../src/arguments/memberRoleChannelCategory";
import { userMemberSnowflakeTypeCaster } from "../src/arguments/userMemberSnowflake";
import { memberRoleChannelTypeCaster } from "../src/arguments/memberRoleChannel";
import { roleSilentTypeCaster, roleTypeCaster } from "../src/arguments/role";
import { userSilentTypeCaster, userTypeCaster } from "../src/arguments/user";
import { memberRoleTypeCaster } from "../src/arguments/memberRole";
import { userMemberTypeCaster } from "../src/arguments/userMember";
import { Experiment, Treatment } from "./interfaces/experiments";
import { codeblockTypeCaster } from "../src/arguments/codeblock";
import { languageTypeCaster } from "../src/arguments/language";
import { listenerTypeCaster } from "../src/arguments/listener";
import { booleanTypeCaster } from "../src/arguments/boolean";
import { commandTypeCaster } from "../src/arguments/command";
import { messageTypeCaster } from "../src/arguments/message";
import { Language, LanguageHandler } from "./util/language";
import { moduleTypeCaster } from "../src/arguments/module";
import { Collection, version as djsver } from "discord.js";
import { PostgresProvider } from "./providers/postgres";
import { CommandHandler } from "./util/commandhandler";
import { Module, ModuleHandler } from "./util/module";
import { FireMember } from "./extensions/guildmember";
import { FireMessage } from "./extensions/message";
import { Client as PGClient } from "ts-postgres";
import { RESTManager } from "./rest/RESTManager";
import { Inhibitor } from "./util/inhibitor";
import { FireConsole } from "./util/console";
import { Listener } from "./util/listener";
import { KSoftClient } from "@aero/ksoft";
import { Command } from "./util/command";
import { Util } from "./util/clientutil";
import * as Sentry from "@sentry/node";
import { Manager } from "./Manager";
import { config } from "../config";
import * as moment from "moment";

import "./extensions";

export class Fire extends AkairoClient {
  launchTime: moment.Moment;
  started: boolean;
  restPing: number;

  // Sharding
  manager: Manager;

  // Logging
  console: FireConsole;
  sentry: typeof Sentry | undefined;

  // Handlers
  guildSettings: PostgresProvider;
  userSettings: PostgresProvider;
  commandHandler: CommandHandler;
  inhibitorHandler: InhibitorHandler;
  listenerHandler: ListenerHandler;
  languages: LanguageHandler;
  modules: ModuleHandler;

  // Common Attributes
  util: Util;
  db: PGClient;
  events: number;
  ksoft?: KSoftClient;
  cacheSweep: () => void;
  config: typeof config.fire;
  cacheSweepTask: NodeJS.Timeout;
  aliases: Collection<string, string[]>;
  experiments: Collection<string, Experiment>;
  conversationStates: Collection<string, Buffer>; // Google Command conversation states

  constructor(manager: Manager, sentry?: typeof Sentry) {
    super({ ...config.akairo, ...config.discord });

    // @ts-ignore
    this.rest = new RESTManager(this);

    this.launchTime = moment();
    this.started = false;
    this.restPing = 0;

    this.manager = manager;
    this.console = new FireConsole(); // TODO make custom console that works in pm2 logs
    this.util = new Util(this);

    this.db = new PGClient({
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASS,
      database: process.env.POSTGRES_DB,
    });

    this.console.warn("[DB] Attempting to connect...");

    this.db
      .connect()
      .then(() => this.console.log("[DB] Connected"))
      .catch((err) => {
        this.console.error(`[DB] Failed to connect\n${err.stack}`);
        this.manager.kill("db_error");
      });

    this.db
      .query("SELECT count FROM socketstats WHERE cluster=$1;", [
        this.manager.id,
      ])
      .then(
        (result) =>
          (this.events = result.rows.length ? (result.rows[0][0] as number) : 0)
      );

    this.experiments = new Collection();
    this.aliases = new Collection();

    this.on("warn", (warning) => this.console.warn(`[Discord] ${warning}`));
    this.on("error", (error) =>
      this.console.error(`[Discord]\n${error.stack}`)
    );
    this.on("ready", () => config.fire.readyMessage(this));
    this.on("raw", () => this.events++);

    if (!this.manager.ws)
      setInterval(async () => {
        await this.db
          .query(
            "INSERT INTO socketstats (cluster, count) VALUES ($1, $2) ON CONFLICT (cluster) DO UPDATE SET count = $2;",
            [this.manager.id, this.events]
          )
          .catch(() => {});
      }, 5000);

    if (sentry) {
      this.sentry = sentry;
      this.sentry.setTag("cluster", this.manager.id.toString());
      this.sentry.setTag("discord.js", djsver);
      this.sentry.setTag("discord-akairo", akairover);
      this.console.log("[Sentry] Connected.");
    }

    this.config = config.fire;

    this.guildSettings = new PostgresProvider(this.db, "guildconfig", {
      idColumn: "gid",
      dataColumn: "data",
    });

    this.userSettings = new PostgresProvider(this.db, "userconfig", {
      idColumn: "uid",
      dataColumn: "data",
    });

    this.commandHandler = new CommandHandler(this, {
      directory: __dirname.includes("/dist/")
        ? "./dist/src/commands/"
        : "./src/commands/",
      commandUtil: true,
      handleEdits: true,
      aliasReplacement: /-/im,
      automateCategories: true,
      commandUtilLifetime: 30000,
      prefix: (message: FireMessage) => {
        return config.fire.dev ? "dev " : ["ts", "ts ", "beta", "beta "];
        // return config.fire.dev
        //   ? "dev "
        //   : [
        //       message.guild.settings.get("config.prefix", "$"),
        //       message.guild.settings.get("config.prefix", "$") + " ",
        //       "fire ",
        //     ];
      },
    });

    this.commandHandler.on(
      "load",
      async (command: Command, isReload: boolean) => {
        await command?.init();
        if (
          command.guilds.length &&
          !command.guilds.some((guild) =>
            (this.options.shards as number[]).includes(
              this.util.getShard(guild)
            )
          )
        ) {
          this.console.warn(
            `[Commands] Removing ${command.id} due to being locked to ${
              command.guilds.length > 1 ? "guilds" : "a guild"
            } on a different cluster`
          );
          return command.remove();
        }
      }
    );

    this.commandHandler.on("remove", async (command: Command) => {
      await command?.unload();
    });

    this.commandHandler.resolver.addTypes({
      "user|member": userMemberTypeCaster,
      "user|member|snowflake": userMemberSnowflakeTypeCaster,
      "member|role": memberRoleTypeCaster,
      "member|role|channel": memberRoleChannelTypeCaster,
      "member|role|channel|category": memberRoleChannelCategoryTypeCaster,
      member: memberTypeCaster,
      memberSilent: memberSilentTypeCaster,
      user: userTypeCaster,
      userSilent: userSilentTypeCaster,
      role: roleTypeCaster,
      roleSilent: roleSilentTypeCaster,
      textChannel: textChannelTypeCaster,
      textChannelSilent: textChannelSilentTypeCaster,
      category: categoryChannelTypeCaster,
      categorySilent: categoryChannelSilentTypeCaster,
      guildChannel: guildChannelTypeCaster,
      guildChannelSilent: guildChannelSilentTypeCaster,
      message: messageTypeCaster,
      boolean: booleanTypeCaster,
      command: commandTypeCaster,
      language: languageTypeCaster,
      listener: listenerTypeCaster,
      module: moduleTypeCaster,
      codeblock: codeblockTypeCaster,
    });

    this.commandHandler.loadAll();

    this.inhibitorHandler = new InhibitorHandler(this, {
      directory: __dirname.includes("/dist/")
        ? "./dist/src/inhibitors/"
        : "./src/inhibitors/",
    });
    this.inhibitorHandler.on(
      "load",
      async (inhibitor: Inhibitor, isReload: boolean) => {
        await inhibitor?.init();
      }
    );
    this.inhibitorHandler.on("remove", async (inhibitor: Inhibitor) => {
      await inhibitor?.unload();
    });

    this.commandHandler.useInhibitorHandler(this.inhibitorHandler);
    this.inhibitorHandler.loadAll();

    this.listenerHandler = new ListenerHandler(this, {
      directory: __dirname.includes("/dist/")
        ? "./dist/src/listeners/"
        : "./src/listeners/",
    });

    this.commandHandler.useListenerHandler(this.listenerHandler);
    this.listenerHandler.setEmitters({
      commandHandler: this.commandHandler,
      inhibitorHandler: this.inhibitorHandler,
      listenerHandler: this.listenerHandler,
      gateway: this.ws,
    });
    this.listenerHandler.loadAll();

    this.languages = new LanguageHandler(this, {
      directory: __dirname.includes("/dist/")
        ? "./dist/src/languages/"
        : "./src/languages/",
    });
    this.languages.loadAll();

    this.modules = new ModuleHandler(this, {
      directory: __dirname.includes("/dist/")
        ? "./dist/src/modules/"
        : "./src/modules/",
    });
    this.modules.on("load", async (module: Module, isReload: boolean) => {
      await module?.init();
    });
    this.modules.on("remove", async (module: Module) => {
      await module?.unload();
    });
    this.modules.loadAll();

    this.conversationStates = new Collection();
    this.ksoft = process.env.KSOFT_TOKEN
      ? new KSoftClient(process.env.KSOFT_TOKEN)
      : undefined;
  }

  async login() {
    if (!this.options.shards) this.options.shards = [this.manager.id];
    this.console.warn(
      `[Discord] Attempting to login on cluster ${
        this.manager.id
      } with shards [${(this.options.shards as number[]).join(", ")}] (Total: ${
        this.options.shardCount
      }).`
    );
    await Promise.all([
      this.loadExperiments(),
      this.loadAliases(),
      this.guildSettings.init(),
      this.userSettings.init(),
    ]);
    this.commandHandler.modules.forEach((command: Command) => {
      if (
        command.guilds.length &&
        !command.guilds.some((guild) =>
          (this.options.shards as number[]).includes(this.util.getShard(guild))
        )
      ) {
        this.console.warn(
          `[Commands] Removing ${command.id} due to being locked to ${
            command.guilds.length > 1 ? "guilds" : "a guild"
          } on a different cluster`
        );
        return command.remove();
      }
    });
    this.cacheSweep = () => {
      this.guilds.cache.forEach((guild) => {
        guild.members.cache.sweep(
          (member: FireMember) => member.id != this.user?.id
        );
        guild.presences.cache.sweep((p) => true);
      });
      this.users.cache.sweep((user) => user.id != this.user?.id);
      if (global.gc) global.gc();
    };
    this.cacheSweepTask = setInterval(this.cacheSweep, 300000);
    return super.login();
  }

  async loadExperiments() {
    this.experiments = new Collection();
    const experiments = await this.db
      .query("SELECT * FROM experiments;")
      .catch(() => {});
    if (!experiments) return;
    for await (const experiment of experiments) {
      const data: Experiment = {
        id: experiment.get("id") as string,
        kind: experiment.get("kind") as "user" | "guild",
        label: experiment.get("label") as string,
        defaultConfig: experiment.get("defaultconfig") as {
          [key: string]: any;
        },
        treatments: (experiment.get("treatments") as unknown) as Treatment[],
      };
      this.experiments.set(data.id, data);
    }
  }

  async loadAliases() {
    this.aliases = new Collection();
    const aliases = await this.db
      .query("SELECT * FROM aliases;")
      .catch(() => {});
    if (!aliases) return;
    for await (const alias of aliases) {
      this.aliases.set(
        alias.get("uid") as string,
        (alias.get("aliases") as string[]).map((a) => a.toLowerCase())
      );
    }
  }

  getCommand(id: string) {
    id = id.toLowerCase();
    if (this.commandHandler.modules.has(id))
      return this.commandHandler.modules.get(id) as Command;
    else {
      const command = this.commandHandler.modules.find((command) =>
        command.aliases.includes(id)
      );
      if (command) return command as Command;
    }
  }

  getLanguage(id: string) {
    return this.languages.modules.get(id) as Language;
  }

  getModule(id: string) {
    return this.modules.modules.get(id.toLowerCase()) as Module;
  }

  getListener(id: string) {
    return this.listenerHandler.modules.get(id) as Listener;
  }

  getInhibitor(id: string) {
    return this.inhibitorHandler.modules.get(id) as Inhibitor;
  }
}
