```typescript
// example types
const TaskVersion1: IDefinition = {
    name: "Task",
    define: {
        name: {
            type: Sequelize.STRING, allowNull: false
        }
    }
    classMethods {
        async staticMethod1(args: string, context: any) {
            return {} as any;
        }
    }
};

const TaskVersion2: IDefinition = {
    define: {
        author: {
            type: Sequelize.STRING, allowNull: false
        }
    },
    relationships: [],
    classMethods {
        staticMethod2(args: string, context: any) {
            return "";
        }
    }
};

//example type definition outputs a typed sequelize model
// IORModel<${adapterType}, ${required}, ${optional}>
type TaskTypeModel = IORModel<IORSequelizeModel, [TaskVersion1], [TaskVersion2]>

interface TaskTypeInstanceExample {
    //...standard instance sequelize methods
    name: string,
    author?: string
}

interface TaskTypeModelExample {
    //...standard model sequelize methods
    staticMethod1: (string, any) => Promise<any>
    staticMethod2?: (string, any) => string

}

// type example

// obj.author = string
// obj.name = string
// const obj2: TaskTypeModel = {}
// static model
// obj.staticMethod2()
// obj.staticMethod1()
// 
```