import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestizeModule, setupSwagger } from "@azerothian/nestize";
import { buildOrm } from "./orm";

async function bootstrap() {
  const orm = await buildOrm();

  // NestizeModule.forRoot(orm, options) registers a generic controller that
  // dispatches REST requests to the ormize resolution engine for every model.
  @Module({
    imports: [
      NestizeModule.forRoot(orm, {
        includeRelations: true,
        // permission: createRoleBasedPermissions("user", { ... }, { defaultDeny: false }),
        // readOnly: false,
        // pathPrefix: "api",
      }),
    ],
  })
  class AppModule {}

  const app = await NestFactory.create(AppModule);

  // Programmatic OpenAPI doc served at /docs (component schemas come from the
  // same ormize-zod4 schemas used to validate request bodies).
  setupSwagger(app, orm, {
    title: "Nestize Example API",
    version: "1.0.0",
    path: "docs",
  });

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`nestize example listening on http://localhost:${port}  (Swagger UI: /docs)`);
}

bootstrap();
