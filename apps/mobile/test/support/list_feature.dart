import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';

/// A feature that behaves like a real list screen: a scrolling list with a filter, and a detail screen on top of it.
/// MOB-09 is the root of the Projects tab, MOB-10 its detail with a path parameter.
const MobileFeature listFeature = MobileFeature(
  id: 'test_list',
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-09', builder: _buildList),
    ScreenSpec(screenId: 'MOB-10', pathSuffix: '/:projectId', builder: _buildDetail),
  ],
);

Widget _buildList(BuildContext context, ScreenContext screen) => const ProjectListScreen();

Widget _buildDetail(BuildContext context, ScreenContext screen) =>
    Scaffold(appBar: AppBar(title: Text('detail ${screen.pathParameters['projectId']}')), body: const SizedBox());

const String filterLabel = 'Only active';

class ProjectListScreen extends StatefulWidget {
  const ProjectListScreen({super.key});

  @override
  State<ProjectListScreen> createState() => _ProjectListScreenState();
}

class _ProjectListScreenState extends State<ProjectListScreen> {
  bool onlyActive = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: <Widget>[
          FilterChip(
            label: const Text(filterLabel),
            selected: onlyActive,
            onSelected: (bool value) => setState(() => onlyActive = value),
          ),
          Expanded(
            child: ListView.builder(
              key: const Key('project-list'),
              itemCount: 60,
              itemBuilder: (BuildContext context, int index) => ListTile(
                title: Text('Project $index'),
                onTap: () => context.go('/projects/mob-10/p$index'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
