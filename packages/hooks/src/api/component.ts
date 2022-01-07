import { IMidwayApplication, IMidwayContainer } from '@midwayjs/core'
import {
  All,
  Controller,
  Del,
  Get,
  Head,
  MidwayFrameworkType,
  Options,
  Patch,
  Post,
  Put,
} from '@midwayjs/decorator'
import {
  AbstractFrameworkAdapter,
  AbstractRouter,
  als,
  ApiRoute,
  createDebug,
  HooksMiddleware,
  HttpTriggerType,
  isHooksMiddleware,
  loadApiModule,
  ResponseMetaData,
  ResponseMetaType,
  setupFramework,
  urlJoin,
  useContext,
  validateArray,
  validateOneOf,
} from '@midwayjs/hooks-core'
import { RuntimeConfig } from '../internal/config/type'
import { createFunctionContainer } from '../internal/container'
import { createConfiguration } from './configuration'
import { getRouter, getSource, isFileSystemRouter } from '../internal'
import { isDevelopment } from '../internal/util'
import { run } from '@midwayjs/glob'
import flattenDeep from 'lodash/flattenDeep'

const debug = createDebug('hooks:component')

interface MidwayApplication extends IMidwayApplication {
  use?: (middleware: any) => void
}

export function HooksComponent(runtimeConfig: RuntimeConfig = {}) {
  if (runtimeConfig.middleware !== undefined) {
    validateArray(runtimeConfig.middleware, 'runtimeConfig.middleware')
  }

  const source = getSource()
  const router = getRouter(isDevelopment())
  const midway = new MidwayFrameworkAdapter(router, null, null)

  const apis = loadApiModules(source, router)
  if (apis.length === 0) {
    console.warn('No api routes found, source is:', source)
  }

  midway.registerApiRoutes(apis)

  const Configuration = createConfiguration({
    namespace: '@midwayjs/hooks',
    async onReady(container: IMidwayContainer, app: MidwayApplication) {
      midway.container = container
      midway.app = app

      midway.registerGlobalMiddleware(runtimeConfig.middleware)
      midway.bindControllers()
    },
  })

  return { Configuration }
}

function loadApiModules(source: string, router: AbstractRouter) {
  const files = run(['**/*.{ts,js}'], {
    cwd: source,
    ignore: [
      '**/node_modules/**',
      '**/*.d.ts',
      '**/*.{test,spec}.{ts,tsx,js,jsx,mjs}',
    ],
  })

  debug('api files to load: %o', files)

  const routes = files
    .filter((file) => router.isApiFile(file))
    .map((file) => {
      const apis = loadApiModule(require(file), file, router)
      debug('load api routes from file: %s %o', file, apis)
      return apis
    })

  return flattenDeep(routes)
}

export class MidwayFrameworkAdapter extends AbstractFrameworkAdapter {
  constructor(
    router: AbstractRouter,
    public app: MidwayApplication,
    public container: IMidwayContainer
  ) {
    super(router)
    setupFramework(this)
  }

  private get frameworkType() {
    return this.app.getFrameworkType()
  }

  private controllers = []
  bindControllers() {
    for (const controller of this.controllers) {
      this.container.bind(controller)
    }
  }

  registerApiRoutes(apis: ApiRoute[]) {
    for (const api of apis) {
      switch (api.trigger.type) {
        case 'HTTP':
          api.middleware = api.middleware?.map((mw) =>
            this.useHooksMiddleware(mw)
          )
          this.controllers.push(this.createHttpApi(api))
          break
        default:
          throw new Error(`Unsupported trigger type: ${api.trigger.type}`)
      }
    }
  }

  private methodDecorators = {
    GET: Get,
    POST: Post,
    PUT: Put,
    DELETE: Del,
    PATCH: Patch,
    HEAD: Head,
    OPTIONS: Options,
    ALL: All,
  }

  createHttpApi(api: ApiRoute) {
    const { functionId, fn, trigger } = api

    validateOneOf(
      trigger.method,
      'trigger.method',
      Object.keys(this.methodDecorators)
    )
    const Method = this.methodDecorators[trigger.method]
    const url = normalizeUrl(this.router, api)

    debug('create http api: %s %s', trigger.method, url)

    if (isDevelopment()) {
      globalThis['HOOKS_ROUTER'] ??= []
      globalThis['HOOKS_ROUTER'].push({
        type: HttpTriggerType.toLowerCase(),
        path: url,
        method: trigger.method,
        functionId,
        handler: `${functionId}.handler`,
      })
    }

    return createFunctionContainer({
      fn,
      functionId,
      parseArgs(ctx) {
        return ctx.request?.body?.args || []
      },
      classDecorators: [Controller()],
      handlerDecorators: [Method(url, { middleware: api.middleware })],
    })
  }

  registerGlobalMiddleware(middlewares: HooksMiddleware[] = []) {
    const runtime =
      this.frameworkType === MidwayFrameworkType.WEB_EXPRESS
        ? this.useExpressRuntime
        : this.useUniversalRuntime

    this.app.use?.(runtime)
    for (const mw of middlewares) {
      this.app.use?.(this.useHooksMiddleware(mw))
    }
  }

  private async useExpressRuntime(req: any, res: any, next: any) {
    throw new Error('Express runtime is not supported. Please use koa.')
  }

  private async useUniversalRuntime(ctx: any, next: any) {
    await als.run({ ctx }, async () => await next())
  }

  private useHooksMiddleware(fn: (...args: any[]) => any) {
    if (!isHooksMiddleware(fn)) return fn

    return (...args: any[]) => {
      const next =
        this.frameworkType === MidwayFrameworkType.WEB_EXPRESS
          ? args[args.length - 1]
          : args[1]
      return fn(next)
    }
  }

  async handleResponseMetaData(metadata: ResponseMetaData[]): Promise<any> {
    const ctx = useContext()

    for (const meta of metadata) {
      switch (meta.type) {
        case ResponseMetaType.CODE:
          ctx.status = meta.code
          break
        case ResponseMetaType.HEADER:
          ctx.set(meta.header.key, meta.header.value)
          break
        case ResponseMetaType.CONTENT_TYPE:
          ctx.type = meta.contentType
          break
        case ResponseMetaType.REDIRECT:
          ctx.status = meta.code || 302
          ctx.redirect(meta.url)
          break
      }
    }
  }
}

export function normalizeUrl(router: AbstractRouter, api: ApiRoute) {
  const { trigger, file } = api

  if (isFileSystemRouter(router)) {
    return urlJoin(router.getRoute(file).basePath, trigger.path, {})
  }

  return trigger.path
}
