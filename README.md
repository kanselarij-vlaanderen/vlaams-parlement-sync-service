# Vlaams Parlement sync service

> [!WARNING]  
> POC branch, README is also work-in-progress!


## Tutorials
### Add the html-to-pdf-service to a stack
Add the following snippet to your `docker-compose.yml` file to include the vlaams-parlement-sync service in your project.

```yml
vlaams-parlement-sync:
  image: kanselarij/vlaams-parlement-sync-service:feature-KAS-2331-poc-1
  volumes:
    - ./data/files:/share # To access the files
    - ./data/debug:/debug # Writes payload.json for debug purposes — warning! it's a big file! your editor may struggle to open it
```

Add the following snippet to your `dispatcher.ex` config file to expose this service's endpoint.

``` elixir
match "/vlaams-parlement-sync/*path", @json_service do
  Proxy.forward conn, path, "http://vlaams-parlement-sync/"
end
```
