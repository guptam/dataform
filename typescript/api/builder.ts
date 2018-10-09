import { utils, adapters } from "@dataform/core";
import * as protos from "@dataform/protos";

export function build(
  compiledGraph: protos.ICompiledGraph,
  runConfig: protos.IRunConfig
) {
  return new Builder(compiledGraph, runConfig).build();
}

class Builder {
  private compiledGraph: protos.ICompiledGraph;
  private runConfig: protos.IRunConfig;

  private adapter: adapters.Adapter;

  constructor(
    compiledGraph: protos.ICompiledGraph,
    runConfig: protos.IRunConfig
  ) {
    this.compiledGraph = compiledGraph;
    this.runConfig = runConfig;
    this.adapter = adapters.create(compiledGraph.projectConfig);
  }

  build(): protos.IExecutionGraph {
    // Firstly, turn every thing into an execution node.
    var allNodes: protos.IExecutionNode[] = [].concat(
      this.compiledGraph.materializations.map(m =>
        this.buildMaterialization(m)
      ),
      this.compiledGraph.operations.map(o => this.buildOperation(o)),
      this.compiledGraph.assertions.map(a => this.buildAssertion(a))
    );

    var allNodeNames = allNodes.map(n => n.name);
    var nodeNameMap: { [name: string]: protos.IExecutionNode } = {};
    allNodes.forEach(node => (nodeNameMap[node.name] = node));

    // Check all dependencies actually exist.
    allNodes.forEach(node => {
      node.dependencies.forEach(dependency => {
        if (allNodeNames.indexOf(dependency) < 0) {
          throw Error(
            `Node "${
              node.name
            }" depends on "${dependency}" which does not exist.`
          );
        }
      });
    });
    // Check for circular dependencies.
    function checkCircular(
      node: protos.IExecutionNode,
      dependents: protos.IExecutionNode[]
    ) {
      if (dependents.indexOf(node) >= 0) {
        throw Error(
          `Circular dependency detected in chain: [${dependents
            .map(d => d.name)
            .join(" > ")} > ${node.name}]`
        );
      }
      node.dependencies.forEach(d =>
        checkCircular(nodeNameMap[d], dependents.concat([node]))
      );
    }
    allNodes.forEach(node => checkCircular(node, []));

    // Determine which nodes should be included.
    var includedNodeNames =
      this.runConfig.nodes && this.runConfig.nodes.length > 0
        ? utils.matchPatterns(this.runConfig.nodes, allNodeNames)
        : allNodeNames;
    var includedNodes = allNodes.filter(
      node => includedNodeNames.indexOf(node.name) >= 0
    );
    if (this.runConfig.includeDependencies) {
      // Compute all transitive dependencies.
      for (let i = 0; i < allNodes.length; i++) {
        includedNodes.forEach(node => {
          var matchingNodeNames =
            node.dependencies && node.dependencies.length > 0
              ? utils.matchPatterns(node.dependencies, allNodeNames)
              : [];
          // Update included node names.
          matchingNodeNames.forEach(nodeName => {
            if (includedNodeNames.indexOf(nodeName) < 0) {
              includedNodeNames.push(nodeName);
            }
          });
          // Update included nodes.
          includedNodes = allNodes.filter(
            node => includedNodeNames.indexOf(node.name) >= 0
          );
        });
      }
    }
    // Remove any excluded dependencies and evaluate wildcard dependencies.
    includedNodes.forEach(node => {
      node.dependencies = utils.matchPatterns(
        node.dependencies,
        includedNodeNames
      );
    });
    return {
      projectConfig: this.compiledGraph.projectConfig,
      runConfig: this.runConfig,
      nodes: includedNodes
    };
  }

  buildMaterialization(materialization: protos.IMaterialization) {
    return protos.ExecutionNode.create({
      name: materialization.name,
      dependencies: materialization.dependencies,
      tasks: ([] as protos.IExecutionTask[]).concat(
        materialization.pres.map(pre => ({ statement: pre })),
        this.adapter.build(materialization, this.runConfig),
        materialization.posts.map(post => ({ statement: post })),
        materialization.assertions.map(assertion => ({
          statement: assertion,
          type: "assertion"
        }))
      )
    });
  }

  buildOperation(operation: protos.IOperation) {
    return protos.ExecutionNode.create({
      name: operation.name,
      dependencies: operation.dependencies,
      tasks: operation.statements.map(statement => ({
        type: "statement",
        statement: statement
      }))
    });
  }

  buildAssertion(assertion: protos.IAssertion) {
    return protos.ExecutionNode.create({
      name: assertion.name,
      dependencies: assertion.dependencies,
      tasks: assertion.queries.map(query => ({
        type: "assertion",
        statement: query
      }))
    });
  }
}
