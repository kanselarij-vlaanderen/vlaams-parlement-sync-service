# Vlaams Parlement sync service

> [!WARNING]  
> POC branch, README is also work-in-progress!


## Tutorials
### Add the html-to-pdf-service to a stack
Add the following snippet to your `docker-compose.yml` file to include the vlaams-parlement-sync service in your project.

```yml
vlaams-parlement-sync:
  image: kanselarij/vlaams-parlement-sync-service:0.3.7
  volumes:
    - ./data/files:/share # To access the files
    - ./data/debug:/debug # Writes payload.json for debug purposes — warning! it's a big file! your editor may struggle to open it
```

The service supports the following environment variables:

```yml
    environment:
      ENABLE_SENDING_TO_VP_API: false # enable/disable the actual call to the VP-API
      ENABLE_DEBUG_FILE_WRITING: true # writes payload.json, response.json, and pieces.json to /debug
      ENABLE_ALWAYS_CREATE_PARLIAMENT_FLOW: true # always creates a (mock) parliament-flow, even when ENABLE_SENDING_TO_VP_API is false
      VP_API_DOMAIN: "https://replace.by.actual.api.url"
      VP_API_CLIENT_ID: "yourVpApiClientId"
      VP_API_CLIENT_SECRET: "yourVpApiClientSecret"
      CACHE_CLEAR_TIMEOUT: 5000 # adds a timeout before sending a response, to give the cache time to clear.
```

Add the following snippet to your `dispatcher.ex` config file to expose this service's endpoint.

``` elixir
match "/vlaams-parlement-sync/*path", @json_service do
  Proxy.forward conn, path, "http://vlaams-parlement-sync/"
end
```
