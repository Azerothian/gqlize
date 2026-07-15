import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { NestizeService } from "../nestize.service";

/**
 * Generic dynamic-dispatch REST controller. All model resources share one set of
 * param routes; the concrete resource/relation/method is resolved at request time
 * by `NestizeService`.
 *
 * ROUTE ORDER MATTERS: literal segments (`select`, `_actions`) are declared before
 * the equivalent-depth `:id` / `:relation` param routes so Express matches the
 * literal first (first-match wins). The optional `pathPrefix` is applied by the
 * module via `@Controller(prefix)` on a subclass.
 */
@Controller()
export class NestizeController {
  constructor(private readonly service: NestizeService) {}

  // 1. literal `select` before `/:resource/:id`
  @Post(":resource/select")
  select(@Param("resource") resource: string, @Body() body: any, @Req() req: any) {
    return this.service.select(resource, body, req);
  }

  // 2-3. class-method actions (`/:resource/_actions/:method`)
  @Get(":resource/_actions/:method")
  classQuery(
    @Param("resource") resource: string,
    @Param("method") method: string,
    @Query() query: any,
    @Req() req: any
  ) {
    return this.service.callClassMethod(resource, method, query, "query", req);
  }

  @Post(":resource/_actions/:method")
  classMutation(
    @Param("resource") resource: string,
    @Param("method") method: string,
    @Body() body: any,
    @Req() req: any
  ) {
    return this.service.callClassMethod(resource, method, body, "mutation", req);
  }

  // 4. instance-method action (`/:resource/:id/_actions/:method`) before :relation/:relId
  @Post(":resource/:id/_actions/:method")
  instanceMethod(
    @Param("resource") resource: string,
    @Param("id") id: string,
    @Param("method") method: string,
    @Body() body: any,
    @Req() req: any
  ) {
    return this.service.callInstanceMethod(resource, id, method, body, req);
  }

  // 5-7. relationships
  @Get(":resource/:id/:relation")
  relationGet(
    @Param("resource") resource: string,
    @Param("id") id: string,
    @Param("relation") relation: string,
    @Query() query: any,
    @Req() req: any
  ) {
    return this.service.relationGet(resource, id, relation, query, req);
  }

  @Post(":resource/:id/:relation")
  relationMutate(
    @Param("resource") resource: string,
    @Param("id") id: string,
    @Param("relation") relation: string,
    @Body() body: any,
    @Req() req: any
  ) {
    return this.service.relationMutate(resource, id, relation, body, req);
  }

  @Delete(":resource/:id/:relation/:relId")
  relationRemove(
    @Param("resource") resource: string,
    @Param("id") id: string,
    @Param("relation") relation: string,
    @Param("relId") relId: string,
    @Req() req: any
  ) {
    return this.service.relationRemove(resource, id, relation, relId, req);
  }

  // 8. single read
  @Get(":resource/:id")
  findOne(@Param("resource") resource: string, @Param("id") id: string, @Req() req: any) {
    return this.service.findOne(resource, id, req);
  }

  // 9-12. collection
  @Get(":resource")
  list(@Param("resource") resource: string, @Query() query: any, @Req() req: any) {
    return this.service.list(resource, query, req);
  }

  @Post(":resource")
  create(@Param("resource") resource: string, @Body() body: any, @Req() req: any) {
    return this.service.create(resource, body, req);
  }

  @Patch(":resource")
  update(@Param("resource") resource: string, @Query() query: any, @Body() body: any, @Req() req: any) {
    return this.service.update(resource, query, body, req);
  }

  @Delete(":resource")
  remove(@Param("resource") resource: string, @Query() query: any, @Req() req: any) {
    return this.service.remove(resource, query, req);
  }
}
