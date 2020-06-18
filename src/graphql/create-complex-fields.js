

export default function createComplexFieldsFunc(
  defName,
  instance,
  definition,
  options,
  schemaCache
) {
  return function complexFields() {

    let fields = schemaCache.complexFields[defName];
    if (!fields && schemaCache.types[defName]) {
      fields = {};
      if (((definition.expose || {}).instanceMethods || {}).query) {
        const instanceMethods = definition.expose.instanceMethods.query;
        Object.keys(instanceMethods).forEach((methodName) => {
          const {type, args} = instanceMethods[methodName];
          let targetType = (type instanceof String || typeof type === "string") ? schemaCache.types[type] : type;
          if (!targetType) {
            //target does not exist.. excluded from base types?
            return;
          }
          if (options.permission) {
            if (options.permission.queryInstanceMethods) {
              const result = options.permission.queryInstanceMethods(defName, methodName, options.permission.options);
              if (!result) {
                return;
              }
            }
          }
          fields[methodName] = {
            type: targetType,
            args,
            description: ((definition.comments || {}).fields || {})[methodName],
            async resolve(source, args, context, info) {
              return source[methodName].apply(source, [args, context]);
            },
          };
        });
      }
      schemaCache.complexFields[defName] = fields;
    }
    return fields;
  };
}
