import type {
  AiApiClient,
  ExamplesByQuadrantDto,
  FeedbackResultDto,
  OcrFeedbackResultDto,
  RetrainResultDto,
  TaskApiClient,
  TaskDto,
  TrainingExampleAddedDto,
} from './index';

type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends
  (<Type>() => Type extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;
type Resolved<Method extends (...args: never[]) => unknown> = Awaited<ReturnType<Method>>;

type ListTasksContract = Expect<Equal<Resolved<TaskApiClient['listTasks']>, TaskDto[]>>;
type AddExampleContract = Expect<
  Equal<Resolved<AiApiClient['addTrainingExample']>, TrainingExampleAddedDto>
>;
type FeedbackContract = Expect<Equal<Resolved<AiApiClient['learnFromFeedback']>, FeedbackResultDto>>;
type OcrFeedbackContract = Expect<
  Equal<Resolved<AiApiClient['learnFromAcceptedOcrTasks']>, OcrFeedbackResultDto>
>;
type RetrainContract = Expect<Equal<Resolved<AiApiClient['retrainModel']>, RetrainResultDto>>;
type ExamplesContract = Expect<
  Equal<Resolved<AiApiClient['getExamplesByQuadrant']>, ExamplesByQuadrantDto>
>;

export type ApiClientTypeContracts =
  | ListTasksContract
  | AddExampleContract
  | FeedbackContract
  | OcrFeedbackContract
  | RetrainContract
  | ExamplesContract;
