const ConcurrencyController = require("../services/concurrency-controller").ConcurrencyController;

describe("Shared image task queue", function describeImageTaskQueue() {
  /** Wait briefly so the test task keeps its queue slot observable. */
  function waitForQueueTask(milliseconds) {
    return new Promise(function createQueueDelay(resolve) {
      setTimeout(resolve, milliseconds);
    });
  }

  /** Verify edits and generation tasks share the configured concurrency limit. */
  it("limits mixed edits and gen tasks together", async function sharedImageQueueTest() {
    let activeCount = 0;
    let maximumActiveCount = 0;
    let concurrency = 2;
    const queue = new ConcurrencyController({
      /** Return the test concurrency value as a server config reader would. */
      getConcurrency: function readTestConcurrency() {
        return concurrency;
      }
    });
    const tasks = [];
    for (let index = 0; index < 6; index += 1) {
      const taskIndex = index;
      const taskType = taskIndex < 3 ? "edits" : "gen";
      tasks.push(queue.run(async function runMixedImageTask() {
        activeCount += 1;
        maximumActiveCount = Math.max(maximumActiveCount, activeCount);
        await waitForQueueTask(10);
        activeCount -= 1;
        return taskType + "-" + taskIndex;
      }, { type: taskType }));
    }
    const results = await Promise.all(tasks);
    expect(results.length).toBe(6);
    expect(maximumActiveCount).toBe(2);
    expect(queue.getSnapshot().active).toBe(0);
    concurrency = 1;
    expect(queue.getSnapshot().concurrency).toBe(1);
  });
});
