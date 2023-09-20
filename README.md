# Vlaams Parlement sync service

> [!WARNING]  
> POC branch, README is also work-in-progress!


## Tutorials
### Add the html-to-pdf-service to a stack
Add the following snippet to your `docker-compose.yml` file to include the vlaams-parlement-sync service in your project.

```yml
vlaams-parlement-sync:
  build: path/to/vlaams-parlement-sync-service
  environment:
    NODE_ENV: "development"
  volumes:
    - path/to/vlaams-parlement-sync-service:/app
    - ./data/files:/share # To access the files
    - ./data/debug:/debug # Writes payload.json for debug purposes — warning! it's a big file! your editor may struggle to open it
```
