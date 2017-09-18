import { sortBy } from 'lodash-es';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as momentProxy from 'moment';
import * as classNamesProxy from 'classnames';
import debounce from 'lodash-es/debounce';
import { SynologyResponse, DownloadStationTask, ApiClient } from 'synology-typescript-api';

// https://github.com/rollup/rollup/issues/1267
const moment: typeof momentProxy = (momentProxy as any).default || momentProxy;
const classNames: typeof classNamesProxy = (classNamesProxy as any).default || classNamesProxy;

import { AdvancedAddTasksForm } from '../common/AdvancedAddTasksForm';
import { VisibleTaskSettings, onStoredStateChange, getHostUrl } from '../state';
import { getSharedObjects } from '../browserApi';
import { addDownloadTasksAndPoll, pollTasks } from '../apiActions';
import { CallbackResponse } from './popupTypes';
import { matchesFilter } from './filtering';
import { Task } from './Task';
import { errorMessageFromCode } from '../apiErrors';
import { shimExtensionApi } from '../apiShim';

shimExtensionApi();

function disabledPropAndClassName(disabled: boolean, className?: string) {
  return {
    disabled,
    className: classNames({ 'disabled': disabled }, className)
  };
}

const NoTasks = (props: { icon: string; text?: string; }) => (
  <div className='no-tasks'>
    <span className={classNames('fa fa-2x', props.icon )}/>
    {props.text && <span className='explanation'>{props.text}</span>}
  </div>
);

interface PopupProps {
  api: ApiClient;
  tasks: DownloadStationTask[];
  taskFetchFailureReason: 'missing-config' | { failureMessage: string } | null;
  tasksLastInitiatedFetchTimestamp: number | null;
  tasksLastCompletedFetchTimestamp: number | null;
  taskFilter: VisibleTaskSettings;
  openDownloadStationUi?: () => void;
  createTasks?: (urls: string[], path?: string) => Promise<void>;
  pauseTask?: (taskId: string) => Promise<CallbackResponse>;
  resumeTask?: (taskId: string) => Promise<CallbackResponse>;
  deleteTask?: (taskId: string) => Promise<CallbackResponse>;
}

interface State {
  shouldShowDropShadow: boolean;
  isAddingTasks: boolean;
}

class Popup extends React.PureComponent<PopupProps, State> {
  private bodyRef?: HTMLElement;

  state: State = {
    shouldShowDropShadow: false,
    isAddingTasks: false
  };

  render() {
    return (
      <div className='popup'>
        {this.renderHeader()}
        <div className={classNames('popup-body', { 'with-foreground': this.state.isAddingTasks })}>
          {this.renderBody()}
          {this.maybeRenderAddDownloadOverlay()}
        </div>
      </div>
    );
  }

  private renderHeader() {
    let text: string;
    let tooltip: string;
    let classes: string | undefined = undefined;
    let icon: string;

    if (this.props.taskFetchFailureReason === 'missing-config') {
      text = 'Settings unconfigured';
      tooltip = 'The hostname, username or password are not configured.';
      icon = 'fa-gear';
    } else if (this.props.tasksLastCompletedFetchTimestamp == null) {
      text = 'Loading...';
      tooltip = 'Loading download tasks...';
      icon = 'fa-refresh fa-spin';
    } else if (this.props.taskFetchFailureReason != null) {
      text = 'Error loading tasks'
      tooltip = this.props.taskFetchFailureReason.failureMessage;
      classes = 'intent-error';
      icon = 'fa-exclamation-triangle';
    } else {
      text = `Updated ${moment(this.props.tasksLastCompletedFetchTimestamp).fromNow()}`;
      tooltip = moment(this.props.tasksLastCompletedFetchTimestamp).format('ll LTS');
      classes = 'intent-success';
      icon = 'fa-check';
    }

    if (
      this.props.tasksLastInitiatedFetchTimestamp != null &&
      this.props.tasksLastCompletedFetchTimestamp != null &&
      this.props.tasksLastInitiatedFetchTimestamp > this.props.tasksLastCompletedFetchTimestamp
    ) {
      icon = 'fa-refresh fa-spin';
      tooltip += ' (updating now)'
    }

    return (
      <header className={classNames({ 'with-shadow': this.state.shouldShowDropShadow })}>
        <div className={classNames('description', classes)} title={tooltip}>
          <div className={classNames('fa fa-lg', icon)}/>
          {text}
        </div>
        <button
          onClick={() => { this.setState({ isAddingTasks: !this.state.isAddingTasks }); }}
          title='Add download...'
          {...disabledPropAndClassName(this.props.createTasks == null)}
        >
          <div className='fa fa-lg fa-plus'/>
        </button>
        <button
          onClick={this.props.openDownloadStationUi}
          title='Open DownloadStation UI...'
          {...disabledPropAndClassName(this.props.openDownloadStationUi == null)}
        >
          <div className='fa fa-lg fa-share-square-o'/>
        </button>
        <button
          onClick={() => { browser.runtime.openOptionsPage(); }}
          title='Open settings...'
          className={classNames({ 'called-out': this.props.taskFetchFailureReason === 'missing-config' })}
        >
          <div className='fa fa-lg fa-cog'/>
        </button>
      </header>
    );
  }

  private renderBody() {
    if (this.props.taskFetchFailureReason === 'missing-config') {
      return <NoTasks icon='fa-gear' text='Configure your hostname, username and password in settings.'/>;
    } else if (this.props.tasksLastCompletedFetchTimestamp == null) {
      return <NoTasks icon='fa-refresh fa-spin'/>;
    } else if (this.props.tasks.length === 0) {
      return <NoTasks icon='fa-circle-o' text='No download tasks.'/>;
    } else {
      const filteredTasks = this.props.tasks.filter(t =>
        (this.props.taskFilter.downloading && matchesFilter(t, 'downloading')) ||
        (this.props.taskFilter.uploading && matchesFilter(t, 'uploading')) ||
        (this.props.taskFilter.completed && matchesFilter(t, 'completed')) ||
        (this.props.taskFilter.errored && matchesFilter(t, 'errored')) ||
        (this.props.taskFilter.other && matchesFilter(t, 'other'))
      );
      if (filteredTasks.length === 0) {
        return <NoTasks icon='fa-filter' text='Download tasks exist, but none match your filters.'/>;
      } else {
        const hiddenTaskCount = this.props.tasks.length - filteredTasks.length;
        return (
          <div className='download-tasks'>
            <ul
              onScroll={this.onBodyScroll}
              ref={e => { this.bodyRef = e; }}
            >
              {sortBy(filteredTasks, t => t.title.toLocaleLowerCase()).map(task => (
                <Task
                  key={task.id}
                  task={task}
                  onDelete={this.props.deleteTask}
                  onPause={this.props.pauseTask}
                  onResume={this.props.resumeTask}
                />
              ))}
            </ul>
            {hiddenTaskCount > 0 && (
              <div className='hidden-count' onClick={() => { browser.runtime.openOptionsPage(); }}>
                ...and {hiddenTaskCount} more hidden task(s).
              </div>)}
          </div>
        );
      }
    }
  }

  private maybeRenderAddDownloadOverlay() {
    if (this.state.isAddingTasks) {
      return (
        <div className='add-download-overlay'>
          <div className='backdrop'/>
          <div className='overlay-content'>
            <AdvancedAddTasksForm
              client={this.props.api}
              onCancel={() => { this.setState({ isAddingTasks: false }); }}
              onAddTasks={(urls, path) => {
                this.props.createTasks!(urls, path);
                this.setState({ isAddingTasks: false });
              }}
            />
          </div>
        </div>
      );
    } else {
      return null;
    }
  }

  private onBodyScroll = debounce(() => {
    if (this.bodyRef) {
      this.setState({ shouldShowDropShadow: this.bodyRef.scrollTop !== 0 })
    } else {
      this.setState({ shouldShowDropShadow: false });
    }
  }, 100);
}

const ELEMENT = document.getElementById('body')!;

getSharedObjects()
  .then(objects => {
    const { api } = objects!;

    pollTasks(api);
    setInterval(() => { pollTasks(api); }, 10000);

    onStoredStateChange(storedState => {

      function convertResponse(response: SynologyResponse<any>): CallbackResponse {
        if (response.success) {
          return 'success';
        } else {
          const reason = errorMessageFromCode(response.error.code, 'DownloadStation.Task');
          console.error(`API call failed, reason: ${reason}`);
          return { failMessage: reason };
        }
      }

      function reloadOnSuccess(response: CallbackResponse) {
        if (response === 'success') {
          return pollTasks(api)
            .then(() => response);
        } else {
          return response;
        }
      }

      const hostUrl = getHostUrl(storedState.connection);

      const openDownloadStationUi = hostUrl
        ? () => {
            browser.tabs.create({
              url: hostUrl + '/index.cgi?launchApp=SYNO.SDS.DownloadStation.Application',
              active: true
            });
          }
        : undefined;

      const createTasks = hostUrl
        ? (urls: string[], path?: string) => {
            return addDownloadTasksAndPoll(api, urls, path);
          }
        : undefined;

      const pauseTask = hostUrl
        ? (taskId: string) => {
            return api.DownloadStation.Task.Pause({ id: [ taskId ] })
              .then(convertResponse)
              .then(reloadOnSuccess);
          }
        : undefined;

      const resumeTask = hostUrl
        ? (taskId: string) => {
            return api.DownloadStation.Task.Resume({ id: [ taskId ] })
              .then(convertResponse)
              .then(reloadOnSuccess);
          }
        : undefined;

      const deleteTask = hostUrl
        ? (taskId: string) => {
            return api.DownloadStation.Task.Delete({
              id: [ taskId ],
              force_complete: false
            })
              .then(convertResponse)
              .then(reloadOnSuccess);
          }
        : undefined;

      ReactDOM.render(
        <Popup
          api={api}
          tasks={storedState.tasks}
          taskFetchFailureReason={storedState.taskFetchFailureReason}
          tasksLastInitiatedFetchTimestamp={storedState.tasksLastInitiatedFetchTimestamp}
          tasksLastCompletedFetchTimestamp={storedState.tasksLastCompletedFetchTimestamp}
          taskFilter={storedState.visibleTasks}
          openDownloadStationUi={openDownloadStationUi}
          createTasks={createTasks}
          pauseTask={pauseTask}
          resumeTask={resumeTask}
          deleteTask={deleteTask}
        />
      , ELEMENT);
    });
});
