import { orchestrator } from '../agents/orchestrator.agent.js';

/**
 * Controller for Agentic RAG Question Generation (Modules 7-11)
 */
export const generateQuestions = async (req, res, next) => {
  try {
    console.log('[Question Controller] Generation request:', {
      class: req.body?.class,
      subject: req.body?.subject,
      topic: req.body?.topic,
      difficulty: req.body?.difficulty,
      questionCount: req.body?.questionCount,
      questionType: req.body?.questionType,
    });

    const result = await orchestrator.generate(req.body || {});

    return res.status(200).json({
      success: true,
      message:
        result.rejected.length > 0
          ? `Generated ${result.questions.length} question(s); ${result.rejected.length} rejected after validation.`
          : `Generated ${result.questions.length} question(s) successfully.`,
      data: result,
    });
  } catch (error) {
    console.error('[Question Controller] Generation error:', error.message);
    next(error);
  }
};

export default { generateQuestions };