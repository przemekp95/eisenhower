import type {
  AiApiClient,
  ExamplesByQuadrantDto,
  FeedbackResultDto,
  OcrFeedbackResultDto,
  RetrainResultDto,
  TaskApiClient,
  TaskDto,
  TaskLifecycleState,
  TrainingExampleAddedDto,
} from './index';

type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type Resolved<Method extends (...args: never[]) => unknown> = Awaited<ReturnType<Method>>;

type ListTasksContract = Expect<Equal<Resolved<TaskApiClient['listTasks']>, TaskDto[]>>;
type LifecycleContract = Expect<
  Equal<Resolved<TaskApiClient['transitionTaskLifecycle']>['lifecycleState'], TaskLifecycleState>
>;
type ScheduleContract = Expect<
  Equal<Resolved<TaskApiClient['updateTaskSchedule']>['schedule'], TaskDto['schedule']>
>;
type DelegatedListContract = Expect<
  Equal<Resolved<TaskApiClient['listDelegatedTasks']>, TaskDto[]>
>;
type DelegationContract = Expect<
  Equal<Resolved<TaskApiClient['updateTaskDelegation']>['delegation'], TaskDto['delegation']>
>;
type AddExampleContract = Expect<
  Equal<Resolved<AiApiClient['addTrainingExample']>, TrainingExampleAddedDto>
>;
type FeedbackContract = Expect<
  Equal<Resolved<AiApiClient['learnFromFeedback']>, FeedbackResultDto>
>;
type OcrFeedbackContract = Expect<
  Equal<Resolved<AiApiClient['learnFromAcceptedOcrTasks']>, OcrFeedbackResultDto>
>;
type RetrainContract = Expect<Equal<Resolved<AiApiClient['retrainModel']>, RetrainResultDto>>;
type ExamplesContract = Expect<
  Equal<Resolved<AiApiClient['getExamplesByQuadrant']>, ExamplesByQuadrantDto>
>;

export type ApiClientTypeContracts =
  | ListTasksContract
  | LifecycleContract
  | ScheduleContract
  | DelegatedListContract
  | DelegationContract
  | AddExampleContract
  | FeedbackContract
  | OcrFeedbackContract
  | RetrainContract
  | ExamplesContract;
