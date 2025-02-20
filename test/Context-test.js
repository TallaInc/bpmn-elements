import Activity from '../src/activity/Activity';
import Context from '../src/Context';
import factory from './helpers/factory';
import testHelpers from './helpers/testHelpers';

const motherOfAllSource = factory.resource('mother-of-all.bpmn');

describe('Context', () => {
  it('takes bpmn context instance and environment', () => {
    const ctx = Context({
      id: 'newDef',
      name: 'New def',
      type: 'fake-context',
      getInboundSequenceFlows() {
        return [];
      },
      getOutboundSequenceFlows() {
        return [];
      },
      getSequenceFlows() {
        return [];
      },
      getMessageFlows() {
        return [];
      },
    });

    expect(ctx).to.have.property('id', 'newDef');
    expect(ctx).to.have.property('name', 'New def');
  });

  describe('getProcessById(id)', () => {
    it('return process', () => {
      const ctx = Context({
        id: 'newDef',
        name: 'New def',
        type: 'fake-context',
        getProcessById() {
          return {
            id: 'theProcess',
            type: 'bpmn:Process',
            behaviour: {},
            Behaviour(def) {
              return {
                id: def.id,
                run() {},
              };
            },
          };
        },
        getInboundSequenceFlows() {
          return [];
        },
        getOutboundSequenceFlows() {
          return [];
        },
      });

      const bp = ctx.getProcessById('theProcess');
      expect(bp).to.have.property('id', 'theProcess');
      expect(bp).to.have.property('run').that.is.a('function');
    });

    it('return null if not found', () => {
      const ctx = Context({
        id: 'newDef',
        name: 'New def',
        type: 'fake-context',
        getProcessById() {},
        getSequenceFlows() {
          return [];
        },
      });

      expect(ctx.getProcessById('theProcess')).to.be.null;
    });
  });

  describe('getActivityById(id)', () => {
    it('return Activity', () => {
      const activityDef = {
        id: 'task',
        type: 'bpmn:Task',
        parent: {
          id: 'theProcess',
        },
        behaviour: {},
        Behaviour(def, context) {
          return Activity(this, def, context);
        },
      };

      const ctx = Context({
        id: 'newDef',
        name: 'New def',
        type: 'fake-context',
        getActivityById() {
          return activityDef;
        },
        getInboundSequenceFlows() {
          return [];
        },
        getOutboundSequenceFlows() {
          return [];
        },
        getSequenceFlows() {
          return [];
        },
      });

      expect(ctx.getActivityById('id')).to.have.property('broker');
    });
  });

  describe('getSequenceFlows(scopeId)', () => {
    let context;
    beforeEach(async () => {
      context = await testHelpers.context(motherOfAllSource);
    });

    it('returns all flows if scoped id is omitted', () => {
      const sequenceFlows = context.getSequenceFlows();
      expect(sequenceFlows).to.have.length(19);
    });

    it('returns same instances if called again', () => {
      const sequenceFlows1 = context.getSequenceFlows();
      const sequenceFlows2 = context.getSequenceFlows();

      for (let i = 0; i < sequenceFlows1.length; i++) {
        expect(sequenceFlows1[i] === sequenceFlows2[i], `${sequenceFlows1[i].id}`).to.be.true;
      }
    });

    it('returns all flows scoped to id', () => {
      expect(context.getSequenceFlows('motherOfAll')).to.have.length(14);
      expect(context.getSequenceFlows('participantProcess')).to.have.length(3);
      expect(context.getSequenceFlows('subProcess1')).to.have.length(2);
    });

    it('returns same instances when scoped to id', () => {
      const sequenceFlows1 = context.getSequenceFlows('subProcess1');
      const sequenceFlows2 = context.getSequenceFlows('subProcess1');

      for (let i = 0; i < sequenceFlows1.length; i++) {
        expect(sequenceFlows1[i] === sequenceFlows2[i], `${sequenceFlows1[i].id}`).to.be.true;
      }
    });
  });

  describe('getInboundSequenceFlows(activityId)', () => {
    let context;
    beforeEach(async () => {
      context = await testHelpers.context(motherOfAllSource);
    });

    it('returns activity inbound sequence flows', () => {
      let inbound = context.getInboundSequenceFlows('scriptTask1');
      expect(inbound).to.have.length(2);

      inbound = context.getInboundSequenceFlows('subScriptTask1');
      expect(inbound).to.have.length(2);
    });

    it('returns same instances if called again', () => {
      const inbound1 = context.getInboundSequenceFlows('scriptTask1');
      const inbound2 = context.getInboundSequenceFlows('scriptTask1');

      for (let i = 0; i < inbound1.length; i++) {
        expect(inbound1[i] === inbound2[i], `${inbound1[i].id}`).to.be.true;
      }
    });

    it('returns same instances as parent process has access to', () => {
      let inbound = context.getInboundSequenceFlows('scriptTask1');
      let sequenceFlows = context.getSequenceFlows('motherOfAll');

      for (let i = 0; i < inbound.length; i++) {
        expect(sequenceFlows.indexOf(inbound[i]), `${inbound[i].id}`).to.be.above(-1);
      }

      inbound = context.getInboundSequenceFlows('subScriptTask1');
      sequenceFlows = context.getSequenceFlows('subProcess1');

      for (let i = 0; i < inbound.length; i++) {
        expect(sequenceFlows.indexOf(inbound[i]), `${inbound[i].id}`).to.be.above(-1);
      }
    });
  });

  describe('getOutboundSequenceFlows(activityId)', () => {
    let context;
    beforeEach(async () => {
      context = await testHelpers.context(motherOfAllSource);
    });

    it('returns activity outbound sequence flows', () => {
      let outbound = context.getOutboundSequenceFlows('scriptTask1');
      expect(outbound).to.have.length(1);

      outbound = context.getOutboundSequenceFlows('subUserTask1');
      expect(outbound).to.have.length(1);
    });

    it('returns same instances if called again', () => {
      const outbound1 = context.getOutboundSequenceFlows('scriptTask1');
      const outbound2 = context.getOutboundSequenceFlows('scriptTask1');

      for (let i = 0; i < outbound1.length; i++) {
        expect(outbound1[i] === outbound2[i], `${outbound1[i].id}`).to.be.true;
      }
    });

    it('returns same instances as parent process has access to', () => {
      let outbound = context.getOutboundSequenceFlows('scriptTask1');
      let sequenceFlows = context.getSequenceFlows('motherOfAll');

      for (let i = 0; i < outbound.length; i++) {
        expect(sequenceFlows.indexOf(outbound[i]), `${outbound[i].id}`).to.be.above(-1);
      }

      outbound = context.getOutboundSequenceFlows('subUserTask1');
      sequenceFlows = context.getSequenceFlows('subProcess1');

      for (let i = 0; i < outbound.length; i++) {
        expect(sequenceFlows.indexOf(outbound[i]), `${outbound[i].id}`).to.be.above(-1);
      }
    });
  });

  describe('clone(environment)', () => {
    it('return context as a clone', async () => {
      const context = await testHelpers.context(factory.userTask('task', 'newDef'));
      const clone = context.clone();
      expect(clone).to.have.property('id', 'newDef');

      expect(context.getProcesses() === clone.getProcesses(), 'same processes').to.be.false;
      expect(context.getProcesses()[0] === clone.getProcesses()[0], 'same process').to.be.false;

      expect(context.getActivityById('task') === clone.getActivityById('task'), 'same child').to.be.false;
      expect(context.getActivityById('task').broker === clone.getActivityById('task').broker, 'same broker').to.be.false;
    });

    it('return cloned context with passed environment', async () => {
      const context = await testHelpers.context(factory.userTask('task', 'newDef'));
      const newEnv = context.environment.clone();
      const subContext = context.clone(newEnv);

      expect(context.environment === subContext.environment, 'same environment').to.be.false;
      expect(subContext.environment === newEnv, 'new environment').to.be.true;
    });

    it('returns sub process elements', async () => {
      const context = await testHelpers.context(motherOfAllSource);
      const activities = context.getActivities();
      const sequenceFlows = context.getSequenceFlows();

      const clone = context.clone(context.environment.clone());
      const clonedActivities = clone.getActivities('subProcess1');
      const clonedSequenceFlows = clone.getSequenceFlows('subProcess1');
      expect(clonedActivities).to.have.length(3);
      expect(clonedSequenceFlows).to.have.length(2);

      for (let i = 0; i < clonedActivities.length; i++) {
        expect(activities.indexOf(clonedActivities[i]), `${clonedActivities[i].id}`).to.equal(-1);
      }

      for (let i = 0; i < clonedSequenceFlows.length; i++) {
        expect(sequenceFlows.indexOf(clonedSequenceFlows[i]), `${clonedSequenceFlows[i].id}`).to.equal(-1);
      }
    });
  });
});
