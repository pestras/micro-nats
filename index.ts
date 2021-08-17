import { Micro, MicroPlugin } from '@pestras/micro';
import { connect, ConnectionOptions, NatsConnection, Msg, JSONCodec, SubscriptionOptions, Subscription, MsgHdrs, PublishOptions, RequestOptions } from 'nats';

export class NatsMsg<T = any> implements Msg {
  public readonly jc = JSONCodec<T>();
  readonly sid: number;
  readonly subject: string;
  readonly reply: string;
  readonly data: Uint8Array;
  readonly headers: MsgHdrs;
  readonly respond: (data?: Uint8Array, opts?: PublishOptions) => boolean;
  json: T & { error?: Error };

  constructor(msg: Msg) {
    this.sid = msg.sid;
    this.subject = msg.subject;
    this.reply = msg.reply;
    this.data = msg.data;
    this.headers = msg.headers;
    this.respond = msg.respond;
    this.json = this.jc.decode(msg.data);
  }
}

export interface NatsEvents {
  onNatsConnected?: (client?: NatsConnection) => void;
}

/**
 * Nats Subject config interface
 */
export interface SubjectConfig {
  hooks?: string[];
  dataQuota?: number;
  options?: SubscriptionOptions;
  meta?: any;
}

export interface SubjectFullConfig extends SubjectConfig {
  key?: string;
  service?: any;
}

/**
 * Nats subjects repo that will hold all defined subjects
 */
let serviceSubjects: { [key: string]: SubjectFullConfig } = {};

/**
 * Nats subject decorator
 * accepts subject configurations
 * @param config 
 */
export function SUBJECT(subject: string, config: SubjectConfig = {}) {
  return (target: any, key: string) => {
    serviceSubjects[subject] = {
      service: target.constructor,
      options: config.options || {},
      hooks: config.hooks || [],
      dataQuota: config.dataQuota || 1024 * 100,
      key
    }
  };
}

async function manageSubscrption(sub: Subscription, config: SubjectFullConfig, service: any) {
  for await (let msg of sub) {
    Micro.logger.info(`subject called: ${msg.subject}`);
    let natsMsg = new NatsMsg(msg);

    // TODO: Check for msg error
    if (config.dataQuota && config.dataQuota < sub.getProcessed()) {
      msg.respond(natsMsg.jc.encode('msg body quota exceeded'));
      return Micro.logger.warn('msg body quota exceeded');
    }

    if (config.hooks && config.hooks.length > 0) {
      let currHook: string;

      try {
        for (let hook of config.hooks) {
          currHook = hook;

          if (service[hook] === undefined && Micro.service[hook] === undefined) {
            natsMsg.respond(natsMsg.jc.encode({ error: { msg: 'hook unhandled error' + currHook } }));
            return Micro.logger.warn(`Hook not found: ${hook}!`);

          } else if (typeof service[hook] !== 'function' && typeof Micro.service[hook] !== 'function') {
            natsMsg.respond(natsMsg.jc.encode({ error: { msg: 'hook unhandled error' + currHook } }));
            return Micro.logger.warn(`invalid hook type: ${hook}!`);
          }

          let ret = service[hook]
            ? service[hook](natsMsg, this._client, config.key, config.meta)
            : Micro.service[hook](natsMsg, this._client, config.key, config.meta);

          if (ret) {
            if (typeof ret.then === "function") {
              let passed = await ret;

              if (!passed) {
                natsMsg.respond(natsMsg.jc.encode({ error: { msg: 'blocked by hook: ' + currHook } }));
                return Micro.logger.info(`subject ${msg.subject} blocked by hook: ${hook}`);
              }
            }

          } else {
            natsMsg.respond(natsMsg.jc.encode({ error: { msg: 'blocked by hook: ' + currHook } }));
            return Micro.logger.info(`subject ${msg.subject} blocked by hook: ${hook}`);
          }
        }
      } catch (e) {
        natsMsg.respond(natsMsg.jc.encode({ error: { msg: 'hook unhandled error' + currHook } }));
        return Micro.logger.error(e);
      }
    }

    try {
      let ret = service[config.key](natsMsg, this._client, config.meta);

      if (ret && typeof ret.then === "function")
        await ret;

      Micro.logger.info(`subject ${msg.subject} ended`);

    } catch (e) {
      natsMsg.respond(natsMsg.jc.encode({ error: { msg: 'unknownError' } }));
      Micro.logger.error(e, `subject: ${msg.subject}, method: ${config.key}`);
    }
  }
}

export class MicroNats extends MicroPlugin {
  private static _instance: MicroNats;
  private static _jsonCodec = JSONCodec();

  private _subs = new Map<string, Subscription>();
  private _client: NatsConnection;

  healthy = true;

  constructor(private _conf: ConnectionOptions = { servers: "localhost:4222" }) {
    super();

    if (MicroNats._instance)
      return MicroNats._instance;

    MicroNats._instance = this;
  }

  get client() { return this._client; }
  get subs() { return this._subs; }

  onExit() {
    !!this._client && this._client.drain().then(() => this.client.close()).catch(() => this.client.close());
  }

  async init() {
    Micro.logger.info('initializing nats server connection');
    this._client = await connect(this._conf);
    Micro.logger.info('connected to nats server successfully');

    if (typeof Micro.service.onNatsConnected === "function")
      Micro.service.onNatsConnected(this._client);

    for (let service of Micro.subServices)
      if (typeof service.onNatsConnected === "function")
        service.onNatsConnected(this._client);

    for (let subject in serviceSubjects) {
      let subjectConf = serviceSubjects[subject];
      let currentService = Micro.getCurrentService(subjectConf.service) || Micro.service;

      if (typeof Micro.service[subjectConf.key] !== "function")
        continue;

      Micro.logger.info('subscribing to subject: ' + subject);
      this._subs.set(subject, this._client.subscribe(subject, subjectConf.options));

      manageSubscrption(this._subs.get(subject), subjectConf, currentService);
    }

    this.ready = true;
    this.live = true;
  }

  static get Client() {
    return MicroNats._instance?.client;
  }

  static get Subscriptions() {
    return MicroNats._instance?.subs;
  }

  static Encode(data: any) {
    return MicroNats._jsonCodec.encode(data);
  }

  static Decode<T = any>(data: Uint8Array) {
    return MicroNats._jsonCodec.decode(data) as T;
  }

  static async Request<T = any>(subject: string, data?: any, opts?: RequestOptions): Promise<NatsMsg<T>> {
    if (!MicroNats.Client)
      throw Error('MicroNats is not connected');

    let res = await MicroNats.Client.request(subject, data ? MicroNats.Encode(data) : undefined, opts);
    return new NatsMsg<T>(res);
  }
}