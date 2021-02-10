const fs = require('fs')
const path = require('path')

const { URL } = require('url')
const qs = require('qs')

const express = require('express')
const consola = require('consola')

const bodyParser = require('body-parser')

const EventEmitter = require('events')
const { ServiceLoader } = require('../interfaces')

class RapidFire extends EventEmitter {
  static constants = {
    defaults: {
      options: {
        isDev: process.env.NODE_ENV !== 'production',
        paths: {
          services: '',
          middlewares: '',
          loaders: '',
        },
        querystringParser: {
          normalize: {
            true: true,
            false: false,
            null: null,
            undefined,
          },
        },
      },
    },
  }

  constructor({ dbs = [], ...options } = {}) {
    super()

    let customOptions = {}

    if (typeof options === 'string') customOptions = require(path.join(__dirname, options))
    else customOptions = options

    this.options = {
      ...RapidFire.constants.defaults.options,
      ...customOptions,
    }

    this.env = {
      paths: {
        root: process.env.PWD,
      },
    }

    this.server = null
    this.dbs = dbs
    this.app = express()
    this.services = []
    this.middlewares = []

    const defaultServiceLoader = new ServiceLoader()
    defaultServiceLoader.$rapidfire = this
    this.loaders = [defaultServiceLoader]
  }

  async ignition() {
    const { isDev } = this.options

    if (isDev) global.$rapidfire = this

    // ------------------------ Load Loaders
    if (this.options.paths.loaders) {
      const loaderFilenames = fs.readdirSync(this.options.paths.loaders)
      const loaders = []
      for (const loaderFilename of loaderFilenames) {
        const Loader = require(path.join(this.options.paths.loaders, loaderFilename))
        const loader = new Loader()

        // Register Middleware Default Variables
        loader.$rapidfire = this

        loaders.push(loader)
      }
      this.loaders = loaders
    }

    // ------------------------ Built-in Request Pre Middlewares
    this.app.use((req, res, next) => {
      if (req.originalUrl.includes('?')) {
        const { search } = new URL(req.url, `${req.protocol}://${req.hostname}`)

        req.query = qs.parse(search.substr(1), {
          arrayLimit: 10000,
          decoder(str, decoder, charset, type) {
            const value = decoder(str, decoder, charset, type)

            if (/^(\d+|\d*\.\d+)$/.test(value)) return parseFloat(value)
            if (value in querystringParser.normalize.keywords) return querystringParser.normalize.keywords[value]
            return value
          },
        })
      }

      next()
    })

    this.app.use(bodyParser.json())

    // ------------------------ Install Controller / Bind Service
    if (this.options.paths.services) {
      const serviceFilenames = fs.readdirSync(this.options.paths.services)
      const services = []
      for (const serviceFilename of serviceFilenames) {
        const Service = require(path.join(this.options.paths.services, serviceFilename))

        const serviceLoader = this.loaders.find(loader => loader instanceof Service.loader)
        const service = await serviceLoader.load({ express, Service })

        this.app.use(service.router)

        services.push(service)
      }
      this.services = services
    }

    // ------------------------ Install Post Middlewares
    if (this.options.paths.middlewares) {
      const middlewareFilenames = fs.readdirSync(this.options.paths.middlewares)
      const middlewares = []
      for (const middlewareFilename of middlewareFilenames) {
        const Middleware = require(path.join(this.options.paths.middlewares, middlewareFilename))
        const middleware = new Middleware()

        middleware.$rapidfire = this

        await middleware.init()

        middlewares.push(middleware)
      }

      this.middlewares = middlewares.sort(({ order: a }, { order: b }) => a - b)

      for (const middleware of this.middlewares) {
        if (middleware.pipe instanceof Function) {
          if (middleware.pattern) this.app.use(pattern, (req, res, next) => middleware.pipe(req, res, next))
          else this.app.use((req, res, next) => middleware.pipe(req, res, next))
        }
      }
    }

    // eslint-disable-next-line no-unused-vars
    this.app.use((err, req, res, next) => {
      consola.error(err)

      if (res.headersSent) return next(err)

      res.status(err.code || 500).send(err.message)
    })

    this.server = this.app.listen(this.options.port, this.options.host, () => {
      consola.ready(`Server listening on http://${this.options.host}:${this.options.port}`)
      this.emit('open')
    })

    this.server.on('close', () => {
      this.server = null
      consola.info('Server Closed.')
      this.emit('close')
    })
  }

  extinguish() {
    for (const client of this.dbs) {
      if (client && client.close instanceof Function) {
        try {
          client.close()
        } catch (err) {
          consola.error(err)
        }
      }
    }

    if (this.server) this.server.close()
  }
}

module.exports = RapidFire
