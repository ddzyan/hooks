import inside from 'is-path-inside'
import { basename, dirname, extname, join, relative, toUnix } from 'upath'
import chalk from 'chalk'

const LambdaMethodPrefix = '_'

export abstract class HooksRouter {
  root: string
  routes = new Map<string, string>()

  private readonly duplicateWarning: Function

  protected constructor(root: string, duplicateWarning = duplicateLogger) {
    this.root = root
    this.duplicateWarning = duplicateWarning
  }

  // src/apis
  abstract get source(): string

  // src/apis/lambda
  getLambdaDirectory(baseDir: string) {
    return join(this.source, baseDir)
  }

  abstract getRouteConfigBySourceFilePath(
    sourceFilePath: string
  ): {
    baseDir: string
    basePath: string
    underscore?: boolean
  }

  isLambdaFile(sourceFilePath: string) {
    if (
      sourceFilePath.endsWith('.test.ts') ||
      sourceFilePath.endsWith('.test.js')
    ) {
      return false
    }

    if (
      extname(sourceFilePath) !== '.ts' &&
      extname(sourceFilePath) !== '.js'
    ) {
      return false
    }

    const route = this.getRouteConfigBySourceFilePath(sourceFilePath)
    return !!route
  }

  protected inside(child: string, parent: string) {
    return inside(toUnix(child), toUnix(parent))
  }

  getBaseUrl(sourceFilePath: string) {
    const url = this.getHTTPPath(sourceFilePath, '', true)
    if (url === '/*') {
      return '/'
    }

    if (url.endsWith('/*')) {
      return url.slice(0, -2)
    }

    return url
  }

  getHTTPPath(
    sourceFilePath: string,
    method: string,
    isExportDefault: boolean
  ) {
    const {
      basePath,
      baseDir,
      underscore,
    } = this.getRouteConfigBySourceFilePath(sourceFilePath)
    const lambdaDirectory = this.getLambdaDirectory(baseDir)

    const { isCatchAllRoutes, filename } = parseFilename(
      basename(sourceFilePath, extname(sourceFilePath))
    )
    const fileRoute = filename === 'index' ? '' : filename
    const methodPrefix = underscore ? LambdaMethodPrefix : ''
    const func = isExportDefault ? '' : `${methodPrefix}${method}`

    const api = toUnix(
      join(
        basePath,
        /**
         * /apis/lambda/index.ts -> ''
         * /apis/lambda/todo/index.ts -> 'todo'
         */
        relative(lambdaDirectory, dirname(sourceFilePath)),
        /**
         * index -> ''
         * demo -> '/demo'
         */
        fileRoute,
        // getTodoList -> _getTodoList
        func,
        isCatchAllRoutes ? '/*' : ''
      )
    )

    /**
     * duplicate routes
     */
    const existPath = this.routes.get(api)
    if (existPath && existPath !== toUnix(sourceFilePath)) {
      this.duplicateWarning(this.root, existPath, sourceFilePath, api)
    }
    this.routes.set(api, toUnix(sourceFilePath))

    return api
  }
}

function parseFilename(filename: string) {
  const re = /\[\.{3}(.+)]/
  const isCatchAllRoutes = re.test(filename)

  return {
    isCatchAllRoutes,
    filename: isCatchAllRoutes ? re.exec(filename)?.[1] : filename,
  }
}

function duplicateLogger(
  root: string,
  existPath: string,
  currentPath: string,
  api: string
) {
  console.log(
    '[ %s ] Duplicate routes detected. %s and %s both resolve to %s. Reference: %s',
    chalk.yellow('warn'),
    chalk.cyan(relative(root, existPath)),
    chalk.cyan(relative(root, currentPath)),
    chalk.cyan(api),
    'https://www.yuque.com/midwayjs/faas/et7x4k'
  )
}
